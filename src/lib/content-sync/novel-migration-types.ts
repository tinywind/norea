import type { ChapterPayloadInventory } from "../chapter-content/inventory";
import type { NovelMetadataV1 } from "../work-metadata/schema";

export interface MigrationWorkIdentity {
  pluginId: string;
  novelId: string;
  novelPath: string;
}

export interface ExplicitSourceContentDiscard {
  approvedByUser: true;
  expectedSourceInventory: ChapterPayloadInventory;
}

export interface NovelMigrationChapter {
  sourceChapterPath: string;
  sourceChapterNumber: string | null;
  targetChapterPath: string | null;
  targetChapterNumber: string | null;
  decision: "copy-source" | "keep-target" | null;
  /** Retain the reading-state mapping while explicitly discarding the source body. */
  discardSourceContent?: true;
  /** Required when discarding a stored server chapter so local file absence never deletes server content. */
  explicitSourceDiscard?: ExplicitSourceContentDiscard;
  /** Set when a local device body was transferred to B and must be uploaded before retiring A on the server. */
  requiresTargetUpload?: true;
  expectedTargetInventory?: ChapterPayloadInventory;
  targetChapter?: { name: string; position: number; page: string };
}

export interface NovelMigrationTargetMetadata {
  novel: NovelMetadataV1["novel"];
  cover: NovelMetadataV1["cover"];
  coverSha256: string | null;
}

export interface WorkMigrationSnapshot {
  work: { id: string; revision: string; identity: MigrationWorkIdentity; metadata?: NovelMetadataV1; coverSha256?: string | null };
  chapters: {
    id: string;
    revision: string;
    chapterPath: string;
    chapterNumber: string | null;
    complete: boolean;
    available: boolean;
  }[];
}

export type NovelMigrationChapterDecision = Pick<NovelMigrationChapter,
  "sourceChapterPath" | "sourceChapterNumber" | "targetChapterPath" | "targetChapterNumber" | "discardSourceContent">;

export interface FinalizeWorkMigrationRequest {
  operationId: string;
  source: { revision: string; chapters: { id: string; revision: string }[] };
  target: { id: string; revision: string };
  chapterDecisions?: NovelMigrationChapterDecision[];
  mappings: ({
    sourceChapterId: string;
    targetChapterId: string;
    targetRevision: string;
    decision: "copy-source" | "keep-target";
    expectedTargetInventory?: ChapterPayloadInventory;
  } | {
    sourceChapterId: string;
    decision: "delete-source";
    explicitSourceDiscard?: ExplicitSourceContentDiscard;
  })[];
}

export interface CopyWorkMigrationChapterRequest {
  decision: "copy-source";
  source: { revision: string; chapter: { id: string; revision: string } };
  target: {
    id: string; revision: string;
    chapter: { chapterPath: string; chapterNumber: string | null; name: string; position: number; page: string };
    expectedChapter: { id: string; revision: string } | null;
  };
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
  targetMetadata?: NovelMigrationTargetMetadata;
  targetCoverDeletionRevision?: string;
  pendingCopyRequest?: CopyWorkMigrationChapterRequest;
  status: "pending" | "failed" | "blocked" | "completed";
  createdAt: number;
  updatedAt: number;
  attempts: number;
  error?: string;
  request?: FinalizeWorkMigrationRequest;
}
