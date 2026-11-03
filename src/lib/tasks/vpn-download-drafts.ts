import type { ChapterRow } from "../../db/queries/chapter";
import type { VpnDownloadPlan, VpnDownloadRunSnapshot } from "./vpn-download-types";

export interface VpnDownloadDraftWork {
  id: string;
  batchId: string;
  title: string;
  pluginId: string;
  novelId: number;
  chapters: readonly Pick<ChapterRow, "id" | "name" | "chapterNumber">[];
  selectedChapterIds: readonly number[];
  error: string | null;
  phase?: "preparing" | "paused" | "failed";
  userPaused?: boolean;
}

export interface VpnDownloadHandoverWork {
  id: string;
  title: string;
  pluginId: string;
  novelId: number;
  chapterIds: readonly number[];
  userPaused?: boolean;
}

export interface VpnDownloadRuntimeSnapshot {
  drafts: readonly VpnDownloadDraftWork[];
  plans: readonly VpnDownloadPlan[];
  loading: boolean;
  error: string | null;
  capabilities: { supported: boolean; parallelSupported: boolean; maxWorkers: number };
  chapterLabels: Readonly<Record<string, Readonly<Record<number, string>>>>;
  run?: VpnDownloadRunSnapshot | null;
  ownedChapterIds?: readonly number[];
  handover?: readonly VpnDownloadHandoverWork[];
}
