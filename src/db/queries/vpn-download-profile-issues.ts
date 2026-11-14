import type {
  VpnDownloadProfileIssue,
  VpnDownloadProfileIssueInput,
} from "../../lib/tasks/vpn-download-types";
import { invokeDbMutation, invokeDbQuery } from "../ipc";

export const VPN_DOWNLOAD_PROFILE_ISSUES_QUERY_KEY = [
  "vpn-download-profile-issues",
] as const;

export async function listVpnDownloadProfileIssues(
  batchId?: string,
): Promise<VpnDownloadProfileIssue[]> {
  return invokeDbQuery<VpnDownloadProfileIssue[]>(
    "db_vpn_profile_issue_list",
    batchId === undefined ? undefined : { batchId },
  );
}

export async function recordVpnDownloadProfileIssue(
  input: VpnDownloadProfileIssueInput,
): Promise<VpnDownloadProfileIssue> {
  return invokeDbMutation<VpnDownloadProfileIssue>(
    "db_vpn_profile_issue_record",
    { input: structuredClone(input) },
  );
}

export async function reallowVpnDownloadProfile(
  batchId: string,
  ip: string,
  expectedRevision: number,
): Promise<VpnDownloadProfileIssue> {
  return invokeDbMutation<VpnDownloadProfileIssue>(
    "db_vpn_profile_issue_reallow",
    { batchId, ip, expectedRevision },
  );
}
