import type { SourceAccessChallenge } from "../plugins/types";
import type { VpnDownloadRangePlan } from "./vpn-download-ranges";
import type { vpnDownloadProfileIssueTable } from "../../db/schema";

export type VpnDownloadMode = "off" | "single" | "parallel";
export type VpnDownloadChallengePolicy = "pause" | "nextProfile";

export interface VpnDownloadPolicies {
  captcha: VpnDownloadChallengePolicy;
  cloudflare: VpnDownloadChallengePolicy;
}

export interface VpnDownloadWorkerRef {
  rangeId: string;
  slot: 0 | 1;
  generation: number;
}

export interface VpnDownloadRangeState extends VpnDownloadRangePlan {
  id: string;
  profileHash: string;
  checkpoint: number;
  phase: "paused" | "connecting" | "running" | "completed" | "cancelled";
  userPaused: boolean;
  pauseReason: string | null;
  attemptedProfileIds: string[];
  attemptProfileId: string | null;
  generation: number;
  challenge: SourceAccessChallenge | null;
}

export interface VpnDownloadPlan {
  id: string;
  batchId: string;
  pluginId: string;
  novelId: number;
  title: string;
  mode: "single" | "parallel";
  policies: VpnDownloadPolicies;
  createdAt: number;
  revision: number;
  ranges: VpnDownloadRangeState[];
}

export type VpnDownloadProfileIssue = typeof vpnDownloadProfileIssueTable.$inferSelect;
export type VpnDownloadProfileIssueCause = VpnDownloadProfileIssue["cause"];
export type VpnDownloadProfileIssueInput = Omit<VpnDownloadProfileIssue, "recordedAt" | "excluded" | "revision">;
