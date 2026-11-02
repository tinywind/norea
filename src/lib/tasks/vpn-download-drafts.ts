import type { ChapterRow } from "../../db/queries/chapter";
import type { VpnDownloadPlan } from "./vpn-download-types";

export interface VpnDownloadDraftWork {
  id: string;
  batchId: string;
  title: string;
  pluginId: string;
  novelId: number;
  chapters: readonly Pick<ChapterRow, "id" | "name" | "chapterNumber">[];
  selectedChapterIds: readonly number[];
  error: string | null;
}

export interface VpnDownloadRuntimeSnapshot {
  drafts: readonly VpnDownloadDraftWork[];
  plans: readonly VpnDownloadPlan[];
  loading: boolean;
  error: string | null;
  capabilities: { supported: boolean; parallelSupported: boolean; maxWorkers: number };
  chapterLabels: Readonly<Record<string, Readonly<Record<number, string>>>>;
}
