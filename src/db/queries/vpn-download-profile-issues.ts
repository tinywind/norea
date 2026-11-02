import type Database from "@tauri-apps/plugin-sql";
import type { VpnDownloadProfileIssue, VpnDownloadProfileIssueInput } from "../../lib/tasks/vpn-download-types";
import { getDb, runDatabaseTransaction } from "../client";
import { readVpnDownloadPlan } from "./vpn-download-plans";

export const VPN_DOWNLOAD_PROFILE_ISSUES_QUERY_KEY = ["vpn-download-profile-issues"] as const;

type IssueRow = Omit<VpnDownloadProfileIssue, "excluded"> & { excluded: number };

const columns = `batch_id AS batchId,ip,profile_id AS profileId,profile_hash AS profileHash,
  plan_id AS planId,range_id AS rangeId,generation,cause,recorded_at AS recordedAt,excluded,revision`;

const decode = (row: IssueRow): VpnDownloadProfileIssue => ({ ...row, excluded: row.excluded === 1 });

async function readIssue(db: Database, batchId: string, ip: string): Promise<VpnDownloadProfileIssue> {
  const [row] = await db.select<IssueRow[]>(`SELECT ${columns} FROM vpn_download_profile_issue WHERE batch_id=$1 AND ip=$2`, [batchId, ip]);
  if (!row) throw new Error("VPN profile issue is missing.");
  return decode(row);
}

export async function listVpnDownloadProfileIssues(batchId?: string): Promise<VpnDownloadProfileIssue[]> {
  const db = await getDb();
  const rows = await db.select<IssueRow[]>(`SELECT ${columns} FROM vpn_download_profile_issue
    ${batchId === undefined ? "" : "WHERE batch_id=$1"} ORDER BY recorded_at DESC,batch_id,ip`, batchId === undefined ? [] : [batchId]);
  return rows.map(decode);
}

export async function recordVpnDownloadProfileIssue(input: VpnDownloadProfileIssueInput): Promise<VpnDownloadProfileIssue> {
  const issue = structuredClone(input);
  return runDatabaseTransaction(async db => {
    const plan = await readVpnDownloadPlan(db, issue.planId);
    const range = plan?.ranges.find(range => range.id === issue.rangeId);
    if (!plan || plan.batchId !== issue.batchId || !range || range.generation !== issue.generation ||
      range.profileId !== issue.profileId || range.profileHash !== issue.profileHash ||
      range.phase === "completed" || range.phase === "cancelled" || !issue.ip.trim()) {
      throw new Error("Stale VPN profile issue owner, identity or generation.");
    }
    await db.execute(`INSERT INTO vpn_download_profile_issue
      (batch_id,ip,profile_id,profile_hash,plan_id,range_id,generation,cause,recorded_at,excluded,revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,1)
      ON CONFLICT(batch_id,ip) DO UPDATE SET
        profile_id=excluded.profile_id,profile_hash=excluded.profile_hash,plan_id=excluded.plan_id,
        range_id=excluded.range_id,generation=excluded.generation,cause=excluded.cause,
        recorded_at=excluded.recorded_at,excluded=1,revision=vpn_download_profile_issue.revision+1`,
    [issue.batchId, issue.ip, issue.profileId, issue.profileHash, issue.planId, issue.rangeId, issue.generation, issue.cause, Date.now()]);
    return readIssue(db, issue.batchId, issue.ip);
  });
}

export async function reallowVpnDownloadProfile(batchId: string, ip: string, expectedRevision: number): Promise<VpnDownloadProfileIssue> {
  return runDatabaseTransaction(async db => {
    const result = await db.execute(`UPDATE vpn_download_profile_issue SET excluded=0,revision=revision+1
      WHERE batch_id=$1 AND ip=$2 AND revision=$3 AND excluded=1`, [batchId, ip, expectedRevision]);
    if (result.rowsAffected !== 1) throw new Error("VPN profile issue has a stale revision or is no longer excluded.");
    return readIssue(db, batchId, ip);
  });
}
