import { invoke } from "@tauri-apps/api/core";
import { runExclusiveDatabaseOperation } from "../db/client";
import type { VpnGateServerVerdict } from "../db/queries/vpn-gate-server-verdict";
import {
  preparePluginVpnProfileChange,
  type PluginVpnServerProtocol,
  type PluginVpnStatus,
} from "./plugin-vpn";

export const SAVED_PLUGIN_VPN_PROFILES_QUERY_KEY = [
  "plugin-vpn", "saved-profiles",
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

export async function captureSavedPluginVpnProfile(
  ip: string,
  source: SavedVpnProfileCaptureSource,
): Promise<VpnGateServerVerdictMutation> {
  const result = await runExclusiveDatabaseOperation<VpnGateServerVerdictMutation>(
    () => invoke("plugin_vpn_capture_saved_profile", { ip, source }),
    { publishMetadata: false },
  );
  publishProfilePoolChange();
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
