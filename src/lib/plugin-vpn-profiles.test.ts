import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../db/client", () => ({
  runExclusiveDatabaseOperation: vi.fn((run: () => Promise<unknown>) => run()),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  applySavedPluginVpnProfile,
  captureSavedPluginVpnProfile,
  listSavedPluginVpnProfiles,
  setSavedPluginVpnProfileLimit,
} from "./plugin-vpn-profiles";

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
});
