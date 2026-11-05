import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../db/client", () => ({
  runExclusiveDatabaseOperation: vi.fn((run: () => Promise<unknown>) => run()),
}));
vi.mock("./android-storage", () => ({
  deleteAndroidContentUriTempFile: vi.fn(async () => undefined),
  syncAndroidVpnProfileFiles: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { deleteAndroidContentUriTempFile, syncAndroidVpnProfileFiles } from "./android-storage";
import {
  applySavedPluginVpnProfile,
  captureSavedPluginVpnProfile,
  listSavedPluginVpnProfiles,
  setSavedPluginVpnProfileLimit,
  syncStoredPluginVpnProfiles,
} from "./plugin-vpn-profiles";

function stubTauriWindow(android: boolean): EventTarget {
  const target = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }, android ? { __NoreaAndroidStorage: {} } : {});
  vi.stubGlobal("window", target);
  return target;
}

beforeEach(() => vi.clearAllMocks());

describe("saved plugin VPN profiles", () => {
  it("pins current approval to its expected hash and IP", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ verdict: null, savedProfile: null, cleanupError: null });
    await captureSavedPluginVpnProfile("8.8.4.4", { kind: "active", expectedHash: "b".repeat(64) });
    expect(invoke).toHaveBeenCalledWith("plugin_vpn_capture_saved_profile", { ip: "8.8.4.4", source: { kind: "active", expectedHash: "b".repeat(64) } });
  });

  it("notifies an active recovery coordinator after an exact profile mutation succeeds, never after failure", async () => {
    const target = new EventTarget(); vi.stubGlobal("window", target);
    let changes = 0; target.addEventListener("norea-vpn-profiles-changed", () => { changes++; });
    vi.mocked(invoke).mockResolvedValueOnce({ verdict: null, savedProfile: null, cleanupError: null });
    await captureSavedPluginVpnProfile("8.8.4.4", { kind: "finder", candidateId: "exact" });
    expect(changes).toBe(1);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("File publication failed"));
    await expect(captureSavedPluginVpnProfile("8.8.4.4", { kind: "finder", candidateId: "exact" })).rejects.toThrow("File publication failed");
    expect(changes).toBe(1); vi.unstubAllGlobals();
  });

  it("lists native metadata without inferring files from historical O verdicts", async () => {
    const snapshot = { limit: 20, profiles: [], cleanupError: null };
    vi.mocked(invoke).mockResolvedValueOnce(snapshot);
    await expect(listSavedPluginVpnProfiles()).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenCalledWith("plugin_vpn_list_saved_profiles");
  });

  it.each([0, 101, 1.5, NaN, Infinity])("rejects invalid capacity %s before IPC", async (limit) => {
    await expect(setSavedPluginVpnProfileLimit(limit)).rejects.toThrow("1 and 100");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([1, 20, 100])("sets bounded integer capacity %s", async (limit) => {
    vi.mocked(invoke).mockResolvedValueOnce({ limit, profiles: [], cleanupError: null });
    await expect(setSavedPluginVpnProfileLimit(limit)).resolves.toMatchObject({ limit });
    expect(invoke).toHaveBeenCalledWith("plugin_vpn_set_saved_profile_limit", { limit });
  });

  it("applies only a retained identity and its expected hash, never a UI path", async () => {
    await applySavedPluginVpnProfile({ id: "a".repeat(64), hash: "a".repeat(64) });
    expect(invoke).toHaveBeenCalledWith("plugin_vpn_apply_saved_profile", { id: "a".repeat(64), expectedHash: "a".repeat(64) });
  });

  it("syncs the desktop storage folder in one native call and announces imported profiles", async () => {
    const target = stubTauriWindow(false);
    let changes = 0; target.addEventListener("norea-vpn-profiles-changed", () => { changes++; });
    vi.mocked(invoke).mockResolvedValueOnce({ imported: 2, errors: [] });
    await syncStoredPluginVpnProfiles();
    expect(invoke).toHaveBeenCalledWith("plugin_vpn_sync_stored_profiles");
    expect(changes).toBe(1);
    vi.unstubAllGlobals();
  });

  it("moves Android profile files only between staged private files and removes the bridge copies", async () => {
    stubTauriWindow(true);
    const plan = { token: "t", publish: [{ fileName: "8.8.8.8.ovpn", inputPath: "/cache/vpn-profile-sync/t/8.8.8.8.ovpn" }], delete: ["1.1.1.1.ovpn"], known: ["8.8.8.8.ovpn"] };
    const result = { reachable: true, published: [{ fileName: "8.8.8.8.ovpn", sha256: "a".repeat(64) }], deleted: ["1.1.1.1.ovpn"],
      inbound: [{ fileName: "vpn.example.com.ovpn", path: "/cache/android-storage-bridge/content-1.tmp" }], errors: [] };
    vi.mocked(invoke).mockResolvedValueOnce(plan).mockResolvedValueOnce({ imported: 1, errors: [] });
    vi.mocked(syncAndroidVpnProfileFiles).mockResolvedValueOnce(result);
    await syncStoredPluginVpnProfiles();
    expect(invoke).toHaveBeenNthCalledWith(1, "plugin_vpn_plan_stored_profile_sync");
    expect(syncAndroidVpnProfileFiles).toHaveBeenCalledWith({ publish: plan.publish, delete: plan.delete, known: plan.known });
    expect(invoke).toHaveBeenNthCalledWith(2, "plugin_vpn_finish_stored_profile_sync", { token: "t", result });
    expect(deleteAndroidContentUriTempFile).toHaveBeenCalledWith("/cache/android-storage-bridge/content-1.tmp");
    vi.unstubAllGlobals();
  });

  it("reports an unreachable Android folder so native keeps its publication record", async () => {
    stubTauriWindow(true);
    vi.mocked(invoke).mockResolvedValueOnce({ token: "t", publish: [], delete: [], known: [] }).mockResolvedValueOnce({ imported: 0, errors: [] });
    vi.mocked(syncAndroidVpnProfileFiles).mockRejectedValueOnce(new Error("Android media storage folder must be selected again."));
    await syncStoredPluginVpnProfiles();
    expect(invoke).toHaveBeenLastCalledWith("plugin_vpn_finish_stored_profile_sync", { token: "t", result: {
      reachable: false, published: [], deleted: [], inbound: [], errors: ["Android media storage folder must be selected again."],
    } });
    vi.unstubAllGlobals();
  });

  it("skips Android sync until a storage folder is selected", async () => {
    stubTauriWindow(true);
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await syncStoredPluginVpnProfiles();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(syncAndroidVpnProfileFiles).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
