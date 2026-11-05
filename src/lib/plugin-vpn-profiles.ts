import { invoke } from "@tauri-apps/api/core";
import { runExclusiveDatabaseOperation } from "../db/client";
import type { VpnGateServerVerdict } from "../db/queries/vpn-gate-server-verdict";
import {
  deleteAndroidContentUriTempFile,
  syncAndroidVpnProfileFiles,
  type AndroidVpnProfileSyncResult,
} from "./android-storage";
import { describeError } from "./errors";
import {
  preparePluginVpnProfileChange,
  type PluginVpnServerProtocol,
  type PluginVpnStatus,
} from "./plugin-vpn";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

export const SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY = [
  "plugin-vpn", "saved-profiles",
] as const;
/** Shares the saved-profile prefix so invalidating saved profiles refreshes imported ones too. */
export const MANUAL_PLUGIN_VPN_PROFILES_QUERY_KEY = [
  ...SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY, "manual",
] as const;
export const SAVED_PLUGIN_VPN_PROFILES_CHANGED_EVENT = "norea-vpn-profiles-changed";

function publishProfilePoolChange(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new Event(SAVED_PLUGIN_VPN_PROFILES_CHANGED_EVENT));
}

export interface SavedVpnProfile {
  id: string;
  ip: string;
  protocol: PluginVpnServerProtocol;
  hash: string;
  approvedAt: number;
  approvalSequence: number;
}

/** A manually imported profile saved under its remote host, which is also its verdict key. */
export interface ManualVpnProfile {
  host: string;
  hash: string;
  savedAt: number;
}

export type SavedVpnProfileCaptureSource =
  | { kind: "finder"; candidateId: string }
  | { kind: "active"; expectedHash: string };

export interface SavedVpnProfileVault {
  limit: number;
  profiles: SavedVpnProfile[];
  cleanupError: string | null;
}

export interface VpnGateServerVerdictMutation {
  verdict: VpnGateServerVerdict | null;
  savedProfile: SavedVpnProfile | null;
  cleanupError: string | null;
}

export function listSavedPluginVpnProfiles(): Promise<SavedVpnProfileVault> {
  return invoke("plugin_vpn_list_saved_profiles");
}

export function listManualPluginVpnProfiles(): Promise<ManualVpnProfile[]> {
  return invoke("plugin_vpn_list_manual_profiles");
}

export async function captureSavedPluginVpnProfile(
  ip: string,
  source: SavedVpnProfileCaptureSource,
): Promise<VpnGateServerVerdictMutation> {
  const result = await runExclusiveDatabaseOperation<VpnGateServerVerdictMutation>(
    () => invoke("plugin_vpn_capture_saved_profile", { ip, source }),
    { publishMetadata: false },
  );
  publishProfilePoolChange();
  void syncStoredPluginVpnProfiles();
  return result;
}

export async function revokeSavedPluginVpnProfile(
  ip: string,
  verdict: "fails" | null,
): Promise<VpnGateServerVerdictMutation> {
  const result = await runExclusiveDatabaseOperation<VpnGateServerVerdictMutation>(
    () => invoke("plugin_vpn_revoke_saved_profile", { ip, verdict }),
    { publishMetadata: false },
  );
  publishProfilePoolChange();
  void syncStoredPluginVpnProfiles();
  return result;
}

export async function setSavedPluginVpnProfileLimit(
  limit: number,
): Promise<SavedVpnProfileVault> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Saved VPN profile capacity must be an integer between 1 and 100");
  }
  const result = await invoke<SavedVpnProfileVault>("plugin_vpn_set_saved_profile_limit", { limit });
  publishProfilePoolChange();
  void syncStoredPluginVpnProfiles();
  return result;
}

export async function applySavedPluginVpnProfile(
  profile: Pick<SavedVpnProfile, "id" | "hash">,
): Promise<PluginVpnStatus> {
  await preparePluginVpnProfileChange();
  return invoke("plugin_vpn_apply_saved_profile", {
    id: profile.id,
    expectedHash: profile.hash,
  });
}

interface StoredVpnProfileSyncPlan {
  token: string;
  publish: { fileName: string; inputPath: string }[];
  delete: string[];
  known: string[];
}

interface StoredVpnProfileSyncReport {
  imported: number;
  errors: string[];
}

let storedSync: Promise<void> | null = null;
let storedSyncAgain = false;

/**
 * Mirrors saved and imported VPN profiles into `vpn-profiles/` of the storage folder and
 * imports profile files found there, such as after a reinstall. A call during a run schedules
 * one more run. Failures are logged; the private copies stay usable for the next run.
 */
export function syncStoredPluginVpnProfiles(): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  if (storedSync) {
    storedSyncAgain = true;
    return storedSync;
  }
  storedSync = (async () => {
    try {
      do {
        storedSyncAgain = false;
        const report = await (isAndroidRuntime() ? syncAndroidStoredProfiles() : runExclusiveDatabaseOperation<StoredVpnProfileSyncReport>(
          () => invoke("plugin_vpn_sync_stored_profiles"),
          { publishMetadata: false },
        ));
        for (const error of report?.errors ?? []) console.warn("[plugin-vpn] stored profile sync", error);
        if (report && report.imported > 0) publishProfilePoolChange();
      } while (storedSyncAgain);
    } catch (error) {
      console.warn("[plugin-vpn] stored profile sync failed", error);
    } finally {
      storedSync = null;
    }
  })();
  return storedSync;
}

async function syncAndroidStoredProfiles(): Promise<StoredVpnProfileSyncReport | null> {
  const plan = await runExclusiveDatabaseOperation<StoredVpnProfileSyncPlan | null>(
    () => invoke("plugin_vpn_plan_stored_profile_sync"),
    { publishMetadata: false },
  );
  if (!plan) return null;
  let result: AndroidVpnProfileSyncResult;
  try {
    result = await syncAndroidVpnProfileFiles({ publish: plan.publish, delete: plan.delete, known: plan.known });
  } catch (error) {
    result = { reachable: false, published: [], deleted: [], inbound: [], errors: [describeError(error)] };
  }
  try {
    return await runExclusiveDatabaseOperation<StoredVpnProfileSyncReport>(
      () => invoke("plugin_vpn_finish_stored_profile_sync", { token: plan.token, result }),
      { publishMetadata: false },
    );
  } finally {
    await Promise.all(result.inbound.map((file) => deleteAndroidContentUriTempFile(file.path).catch((error: unknown) =>
      console.warn("[plugin-vpn] stored profile temp cleanup failed", error))));
  }
}
