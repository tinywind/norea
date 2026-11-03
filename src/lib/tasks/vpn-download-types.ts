import type { SourceAccessChallenge } from "../plugins/types";
import type { VpnDownloadRangePlan } from "./vpn-download-ranges";
import type { vpnDownloadProfileIssueTable } from "../../db/schema";

export type VpnDownloadMode = "off" | "single" | "parallel";
export type VpnDownloadChallengePolicy = "pause" | "nextProfile";

export const MAX_VPN_DOWNLOAD_WORKERS = 10;
export type VpnDownloadWorkerSlot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export function isVpnDownloadWorkerSlot(value: unknown): value is VpnDownloadWorkerSlot {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MAX_VPN_DOWNLOAD_WORKERS;
}

export interface VpnDownloadPolicies {
  captcha: VpnDownloadChallengePolicy;
  cloudflare: VpnDownloadChallengePolicy;
}

export interface VpnDownloadLaunchOptions {
  workerCount: number;
  captchaPolicy: VpnDownloadChallengePolicy;
  cloudflarePolicy: VpnDownloadChallengePolicy;
}

export interface VpnDownloadRunSnapshot extends VpnDownloadLaunchOptions {
  id: string;
  status: "starting" | "running" | "paused" | "completed" | "cancelling" | "cancelled" | "interrupted";
  activeWorkers: number;
  connectingWorkers: number;
  closingWorkers: number;
}

export interface VpnDownloadWorkerRef {
  rangeId: string;
  slot: VpnDownloadWorkerSlot;
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
