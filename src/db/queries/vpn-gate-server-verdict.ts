import { getDb } from "../client";

export type VpnGateServerVerdictValue = "works" | "fails";

export interface VpnGateServerVerdict {
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
): Promise<void> {
  const db = await getDb();
  if (verdict === null) {
    await db.execute(
      `DELETE FROM vpn_gate_server_verdict
       WHERE ip = $1`,
      [ip],
    );
    return;
  }

  await db.execute(
    `INSERT INTO vpn_gate_server_verdict (ip, verdict)
     VALUES ($1, $2)
     ON CONFLICT(ip) DO UPDATE SET
       verdict = excluded.verdict,
       updated_at = unixepoch()`,
    [ip, verdict],
  );
}
