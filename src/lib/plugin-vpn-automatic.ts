import { invoke } from "@tauri-apps/api/core";
import type { PluginVpnServerProtocol } from "./plugin-vpn";

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
