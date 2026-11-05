import { getDb } from "../client";
import {
  captureSavedPluginVpnProfile,
  revokeSavedPluginVpnProfile,
  type SavedVpnProfileCaptureSource,
  type VpnGateServerVerdictMutation,
} from "../../lib/plugin-vpn-profiles";

export type VpnGateServerVerdictValue = "works" | "fails";

export interface VpnGateServerVerdict {
  /** The server's remote host: a VPN Gate IPv4 address or an imported profile's host. */
  ip: string;
  verdict: VpnGateServerVerdictValue;
  updatedAt: number;
}

export async function listVpnGateServerVerdicts(): Promise<
  VpnGateServerVerdict[]
> {
  const db = await getDb();
  return db.select<VpnGateServerVerdict[]>(
    `SELECT
       ip,
       verdict,
       updated_at AS updatedAt
     FROM vpn_gate_server_verdict
     ORDER BY ip`,
  );
}

export async function setVpnGateServerVerdict(
  ip: string,
  verdict: VpnGateServerVerdictValue | null,
  source?: SavedVpnProfileCaptureSource,
): Promise<VpnGateServerVerdictMutation> {
  if (verdict === "works") {
    if (!source) {
      throw new Error("Approving a VPN Gate server requires its exact profile");
    }
    return captureSavedPluginVpnProfile(ip, source);
  }
  return revokeSavedPluginVpnProfile(ip, verdict);
}
