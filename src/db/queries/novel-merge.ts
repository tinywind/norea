import type { ChapterCompositionV1 } from "../../lib/chapter-composition";
import type { ChapterCompositionPreparedCopy } from "../../lib/chapter-composition-storage";
import type { ChapterContentType } from "../../lib/chapter-content";
import type { ChapterPayloadInventory } from "../../lib/chapter-content/inventory";
import type { WorkMigrationLineage } from "../../lib/content-sync/migration-feed-state";
import type {
  NovelMigrationTargetMetadata,
  WorkMigrationSnapshot,
} from "../../lib/content-sync/novel-migration-types";
import type { DatabaseReadMode } from "../client";
import { invokeDbMutation, invokeDbQuery } from "../ipc";

export type NovelMergeChapterDecision =
  | {
      sourceChapterId: number;
      kind: "map";
      targetChapterPath: string;
    }
  | {
      sourceChapterId: number;
      kind: "exclude";
    };

export interface ReleaseMigratedTargetWork {
  workId: string;
  pluginId: string;
  novelPath: string;
}

export interface IncomingMigrationCommit {
  serverUrl: string;
  expectedOperationId: string;
  expectedSequence: number;
  chain: readonly WorkMigrationLineage[];
  releaseTargetWork?: ReleaseMigratedTargetWork;
}

export interface ApplyNovelMergeInput {
  sourceNovelId: number;
  targetNovelId: number;
  decisions: readonly NovelMergeChapterDecision[];
  preparedDownloads: readonly PreparedNovelMergeDownload[];
  composition?: ChapterCompositionV1;
  preparedCompositionCopies?: readonly ChapterCompositionPreparedCopy[];
  readingStateSourcePathByTargetPath?: Readonly<Record<string, string>>;
  skipSourceContentChapterIds?: readonly number[];
  contentSyncServerUrl?: string;
  contentSyncSourceSnapshot?: WorkMigrationSnapshot;
  contentSyncTargetMetadata?: NovelMigrationTargetMetadata;
  incomingMigrationCommit?: IncomingMigrationCommit;
  storageTransferToken?: string;
}

export interface PreparedNovelMergeDownload {
  sourceChapterId: number;
  contentType: ChapterContentType;
  contentBytes: number;
  mediaBytes: number;
  transferredFromSource: boolean;
  mediaComplete?: boolean;
  targetInventory?: ChapterPayloadInventory;
  targetInventoryBodyOnly?: boolean;
}

export interface NovelMergeDatabaseResult {
  targetNovelId: number;
  chapterIdMap: Record<number, number>;
  preferredLastReadChapterId: number | null;
  transferredDownloads: number;
}

export interface NovelMergeTargetPreviewRecord {
  novelId: number;
  composition: ChapterCompositionV1 | null;
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

export async function findNovelMergeTargetPreview(
  pluginId: string,
  path: string,
  sourceNovelId: string,
  readMode?: DatabaseReadMode,
): Promise<NovelMergeTargetPreviewRecord | null> {
  return invokeDbQuery<NovelMergeTargetPreviewRecord | null>(
    "db_novel_merge_find_target_preview",
    { pluginId, path, sourceNovelId, ...(readMode ? { readMode } : {}) },
  );
}

export async function applyNovelMergeInDb(
  input: ApplyNovelMergeInput,
): Promise<NovelMergeDatabaseResult> {
  if (input.incomingMigrationCommit && input.contentSyncServerUrl) {
    throw new Error("An incoming migration cannot create an outgoing migration.");
  }
  assertPositiveId(input.sourceNovelId, "Source novel id");
  assertPositiveId(input.targetNovelId, "Target novel id");
  if (input.sourceNovelId === input.targetNovelId) {
    throw new Error("Source and target novels must be different.");
  }

  return invokeDbMutation<NovelMergeDatabaseResult>("db_novel_merge_apply", {
    input: {
      sourceNovelId: input.sourceNovelId,
      targetNovelId: input.targetNovelId,
      decisions: input.decisions,
      preparedDownloads: input.preparedDownloads,
      ...(input.composition ? { composition: input.composition } : {}),
      ...(input.preparedCompositionCopies
        ? { preparedCompositionCopies: input.preparedCompositionCopies }
        : {}),
      ...(input.readingStateSourcePathByTargetPath
        ? { readingStateSourcePathByTargetPath: input.readingStateSourcePathByTargetPath }
        : {}),
      ...(input.skipSourceContentChapterIds
        ? { skipSourceContentChapterIds: input.skipSourceContentChapterIds }
        : {}),
      ...(input.contentSyncServerUrl
        ? { contentSyncServerUrl: input.contentSyncServerUrl }
        : {}),
      ...(input.contentSyncSourceSnapshot
        ? { contentSyncSourceSnapshot: input.contentSyncSourceSnapshot }
        : {}),
      ...(input.contentSyncTargetMetadata
        ? { contentSyncTargetMetadata: input.contentSyncTargetMetadata }
        : {}),
      ...(input.incomingMigrationCommit
        ? { incomingMigrationCommit: input.incomingMigrationCommit }
        : {}),
      ...(input.storageTransferToken
        ? { storageTransferToken: input.storageTransferToken }
        : {}),
    },
  });
}

export async function completeIncomingNovelMigration(
  commit: IncomingMigrationCommit,
): Promise<void> {
  await invokeDbMutation<void>("db_novel_merge_complete_incoming_migration", {
    commit,
  });
}
