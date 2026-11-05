import { invoke } from "@tauri-apps/api/core";
import { runExclusiveDatabaseOperation } from "../db/client";
import type { PluginVpnServerProtocol } from "./plugin-vpn";
import { syncStoredPluginVpnProfiles, type SavedVpnProfile } from "./plugin-vpn-profiles";

export const AUTOMATIC_PLUGIN_VPN_PROFILES_QUERY_KEY = ["plugin-vpn", "automatic-profiles"] as const;

/** A VPN Gate server that passed an automatic test. It never carries or changes an O/X verdict. */
export interface AutomaticVpnProfile {
  id: string;
  ip: string;
  protocol: PluginVpnServerProtocol;
  hash: string;
  score: number;
  testedAt: number;
  failures: number;
}

export function listAutomaticPluginVpnProfiles(): Promise<AutomaticVpnProfile[]> {
  return invoke("plugin_vpn_list_automatic_profiles");
}

/** Test-connects a cached Finder candidate; true when it joined the automatic pool. */
export function testAutomaticPluginVpnCandidate(candidateId: string): Promise<boolean> {
  return invoke("plugin_vpn_test_automatic_candidate", { candidateId });
}

export function recordAutomaticPluginVpnProfileResult(profile: Pick<AutomaticVpnProfile, "id" | "hash">, connected: boolean): Promise<void> {
  return invoke("plugin_vpn_record_automatic_profile_result", { id: profile.id, expectedHash: profile.hash, connected });
}

/**
 * "Approve all working": saves every tested server without a recent tunnel
 * failure as an O-approved profile and returns the newly approved ones. It
 * is the user's explicit verdict; the app never approves servers by itself.
 */
export async function approveWorkingAutomaticPluginVpnProfiles(): Promise<SavedVpnProfile[]> {
  const approved = await runExclusiveDatabaseOperation<SavedVpnProfile[]>(
    () => invoke("plugin_vpn_approve_working_automatic_profiles"),
    { publishMetadata: false },
  );
  void syncStoredPluginVpnProfiles();
  return approved;
}
