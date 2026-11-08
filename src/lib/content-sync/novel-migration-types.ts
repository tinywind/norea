import type { ChapterPayloadInventory } from "../chapter-content/inventory";

export interface MigrationWorkIdentity {
  pluginId: string;
  novelId: string;
  novelPath: string;
}

export interface NovelMigrationChapter {
  sourceChapterPath: string;
  sourceChapterNumber: string | null;
  targetChapterPath: string | null;
  targetChapterNumber: string | null;
  decision: "copy-source" | "keep-target" | null;
  expectedTargetInventory?: ChapterPayloadInventory;
}

export interface WorkMigrationSnapshot {
  work: { id: string; revision: string; identity: MigrationWorkIdentity };
  chapters: {
    id: string;
    revision: string;
    chapterPath: string;
    chapterNumber: string | null;
    complete: boolean;
    available: boolean;
  }[];
}

export interface FinalizeWorkMigrationRequest {
  operationId: string;
  source: { revision: string; chapters: { id: string; revision: string }[] };
  target: { id: string; revision: string };
  mappings: {
    sourceChapterId: string;
    targetChapterId: string;
    targetRevision: string;
    decision: "copy-source" | "keep-target";
    expectedTargetInventory?: ChapterPayloadInventory;
  }[];
}

export interface PendingNovelMigration {
  version: 1;
  operationId: string;
  serverUrl: string;
  source: MigrationWorkIdentity;
  target: MigrationWorkIdentity;
  targetLocalNovelId: number;
  chapters: NovelMigrationChapter[];
  sourceSnapshot?: WorkMigrationSnapshot;
  status: "pending" | "failed" | "blocked" | "completed";
  createdAt: number;
  updatedAt: number;
  attempts: number;
  error?: string;
  request?: FinalizeWorkMigrationRequest;
}
