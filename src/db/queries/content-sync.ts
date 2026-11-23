import { invokeDbMutation, invokeDbQuery } from "../ipc";
import { isChapterPayloadInventory, type ChapterPayloadInventory } from "../../lib/chapter-content/inventory";
import type {
  ExplicitSourceContentDiscard,
  MigrationWorkIdentity,
  NovelMigrationTargetMetadata,
  PendingNovelMigration,
  WorkMigrationSnapshot,
} from "../../lib/content-sync/novel-migration-types";
import { normalizeContentServerUrl } from "../../lib/content-sync/client";
import type { PackageManifest } from "../../lib/content-sync/native";
import type { ServerChapterSummary } from "../../lib/content-sync/chapters";

export async function cacheServerChapters(
  novelId: number,
  chapters: readonly ServerChapterSummary[],
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (chapters.length === 0) return false;
  let changed = false;
  for (let offset = 0; offset < chapters.length; offset += 100) {
    if (signal?.aborted) break;
    const batch = chapters.slice(offset, offset + 100);
    const batchChanged = await invokeDbMutation<boolean>(
      "db_content_sync_cache_server_chapters",
      { novelId, chapters: batch },
    );
    changed ||= batchChanged;
  }
  // Report navigation cancellation after committing already cached chapters.
  signal?.throwIfAborted();
  return changed;
}

export async function readContentSyncCache(key: string): Promise<string | null> {
  return invokeDbQuery<string | null>("db_content_sync_read_cache", {
    key,
    readMode: "queued",
  });
}

export async function writeContentSyncCache(key: string, payload: string): Promise<void> {
  await invokeDbMutation("db_content_sync_write_cache", { key, payload });
}

export async function clearServerChapterDownloadProof(chapterId: number): Promise<void> {
  await invokeDbMutation("db_content_sync_clear_download_proof", { chapterId });
}

export async function rememberServerChapterDownload(
  row: ContentSyncChapter,
  serverUrl: string,
  fingerprint: string,
): Promise<void> {
  await writeContentSyncCache(
    `norea-content-chapter-source:${row.chapterId}`,
    JSON.stringify({
      chapterId: row.chapterId,
      novelId: row.novelId,
      pluginId: row.pluginId,
      sourceNovelId: row.sourceNovelId,
      novelPath: row.novelPath,
      chapterPath: row.chapterPath,
      chapterNumber: row.chapterNumber,
      position: row.position,
      serverUrl,
      fingerprint,
    }),
  );
}

export interface ContentSyncChapter {
  chapterId: number;
  novelId: number;
  pluginId: string;
  novelPath: string;
  sourceNovelId: string | null;
  chapterPath: string;
  novelName: string;
  author: string | null;
  summary: string | null;
  isLocal: boolean;
  chapterName: string;
  chapterNumber: string | null;
  position: number;
  page: string;
  contentType: PackageManifest["chapter"]["contentType"];
  isDownloaded: boolean;
  mediaRepairNeeded: boolean;
  isDownloadQueued: boolean;
  contentBytes: number;
  mediaBytes: number;
}

export async function listContentSyncChapters(
  identities?: string[],
  downloadedOnly = false,
): Promise<ContentSyncChapter[]> {
  return selectContentSyncChapters(identities, downloadedOnly, false);
}

export async function listContentSyncWorkChapters(
  workIdentities: string[],
): Promise<ContentSyncChapter[]> {
  return selectContentSyncChapters(workIdentities, true, true);
}

/**
 * Returns durable local chapter payloads which this server has never recorded as
 * downloaded. The cache JSON is expanded once inside SQLite so large libraries
 * do not cross the native bridge merely to discard already-known chapters.
 */
export async function listUntrackedContentSyncChapters(
  serverUrl: string,
): Promise<ContentSyncChapter[]> {
  return invokeDbQuery<ContentSyncChapter[]>(
    "db_content_sync_list_untracked_chapters",
    { serverUrl },
  );
}

async function selectContentSyncChapters(
  identities: string[] | undefined,
  downloadedOnly: boolean,
  matchWorks: boolean,
): Promise<ContentSyncChapter[]> {
  if (identities?.length === 0) return [];
  if (identities && identities.length > 100) {
    const rows: ContentSyncChapter[] = [];
    for (let offset = 0; offset < identities.length; offset += 100) {
      rows.push(
        ...(await selectContentSyncChapters(
          identities.slice(offset, offset + 100),
          downloadedOnly,
          matchWorks,
        )),
      );
    }
    return rows;
  }
  return invokeDbQuery<ContentSyncChapter[]>("db_content_sync_list_chapters", {
    identities: identities ?? null,
    downloadedOnly,
    matchWorks,
    readMode: "queued",
  });
}

export async function canUploadContentChapter(chapterId: number): Promise<boolean> {
  return invokeDbQuery<boolean>("db_content_sync_can_upload_chapter", {
    chapterId,
    readMode: "queued",
  });
}

export async function importContentMetadata(
  manifest: PackageManifest,
  serverUrl?: string,
): Promise<{ novelId: number; chapterId: number }> {
  return invokeDbMutation<{ novelId: number; chapterId: number }>(
    "db_content_sync_import_metadata",
    { manifest, serverUrl: serverUrl ?? null },
  );
}

export async function markContentInstalled(
  chapterId: number,
  contentType: string,
  contentBytes: number,
  mediaBytes: number,
  mediaComplete: boolean,
): Promise<void> {
  await invokeDbMutation("db_content_sync_mark_installed", {
    chapterId,
    contentType,
    contentBytes,
    mediaBytes,
    mediaComplete,
  });
}

export function contentIdentity(
  pluginId: string,
  novelPath: string,
  chapterPath = "",
): string {
  return JSON.stringify([pluginId, novelPath, chapterPath]);
}

export interface ContentJournalEntry {
  sequence: number;
  key: string;
}

export async function contentJournalHead(): Promise<number> {
  return invokeDbQuery<number>("db_content_sync_journal_head", {
    readMode: "queued",
  });
}

export async function readContentJournal(
  after: number,
  through: number,
): Promise<ContentJournalEntry[]> {
  return invokeDbQuery<ContentJournalEntry[]>("db_content_sync_read_journal", {
    after,
    through,
    readMode: "queued",
  });
}

/** Journals a source fetch under `source-download:<identity>` so content sync can tell it from a copy of a deleted server chapter. */
export async function recordContentSourceDownload(chapterId: number): Promise<boolean> {
  return invokeDbMutation<boolean>("db_content_sync_record_source_download", { chapterId });
}

const NOVEL_MIGRATION_CACHE_PREFIX = "norea-content-novel-migration:";

function migrationCacheKey(operationId: string): string {
  return `${NOVEL_MIGRATION_CACHE_PREFIX}${operationId}`;
}

function validMigrationIdentity(
  value: MigrationWorkIdentity | undefined,
): value is MigrationWorkIdentity {
  return (
    !!value &&
    [value.pluginId, value.novelId, value.novelPath].every(
      (part) => typeof part === "string" && part.trim().length > 0,
    )
  );
}

function parseNovelMigration(payload: string): PendingNovelMigration {
  const job = JSON.parse(payload) as PendingNovelMigration;
  if (
    job.version !== 1 ||
    typeof job.operationId !== "string" ||
    !job.operationId ||
    typeof job.serverUrl !== "string" ||
    !validMigrationIdentity(job.source) ||
    !validMigrationIdentity(job.target) ||
    !Array.isArray(job.chapters) ||
    job.chapters.some(
      (chapter) =>
        (chapter.discardSourceContent !== undefined &&
          (chapter.discardSourceContent !== true ||
            chapter.decision !== null ||
            !chapter.targetChapterPath ||
            chapter.expectedTargetInventory !== undefined)) ||
        (chapter.explicitSourceDiscard !== undefined &&
          (chapter.explicitSourceDiscard.approvedByUser !== true ||
            !isChapterPayloadInventory(
              chapter.explicitSourceDiscard.expectedSourceInventory,
            ) ||
            !chapter.explicitSourceDiscard.expectedSourceInventory.body)) ||
        (chapter.requiresTargetUpload !== undefined &&
          (chapter.requiresTargetUpload !== true ||
            chapter.decision !== "copy-source" ||
            !chapter.targetChapterPath)),
    ) ||
    !["pending", "failed", "blocked", "completed"].includes(job.status) ||
    (job.targetCoverDeletionRevision !== undefined &&
      (typeof job.targetCoverDeletionRevision !== "string" ||
        !job.targetCoverDeletionRevision))
  ) {
    throw new Error(
      "Stored novel migration is invalid. The source work remains protected.",
    );
  }
  return job;
}

export interface RecordPendingNovelMergeInput {
  serverUrl: string;
  sourceNovelId: number;
  targetNovelId: number;
  chapterIdMap: Readonly<Record<number, number>>;
  skipSourceContentChapterIds?: readonly number[];
  explicitServerDiscardBySourceId?: Readonly<
    Record<number, ExplicitSourceContentDiscard>
  >;
  sourceSnapshot?: WorkMigrationSnapshot;
  targetMetadata?: NovelMigrationTargetMetadata;
  preparedDownloads: readonly {
    sourceChapterId: number;
    transferredFromSource: boolean;
    targetInventory?: ChapterPayloadInventory;
    targetInventoryBodyOnly?: boolean;
  }[];
}

export async function recordPendingNovelMerge(
  input: RecordPendingNovelMergeInput,
): Promise<string> {
  return invokeDbMutation<string>(
    "db_content_sync_record_pending_novel_merge",
    { input },
  );
}

export async function listNovelMigrations(
  serverUrl: string,
  includeCompleted = false,
): Promise<PendingNovelMigration[]> {
  if (!serverUrl.trim()) return [];
  const normalizedServerUrl = normalizeContentServerUrl(serverUrl);
  const rows = await invokeDbQuery<Array<{ cacheKey: string; payload: string }>>(
    "db_content_sync_list_cache_entries",
    {
      prefix: NOVEL_MIGRATION_CACHE_PREFIX,
      exactSubstr: false,
      readMode: "queued",
    },
  );
  return rows
    .map((row) => parseNovelMigration(row.payload))
    .filter(
      (job) =>
        normalizeContentServerUrl(job.serverUrl) === normalizedServerUrl &&
        (includeCompleted || job.status !== "completed"),
    );
}

export async function saveNovelMigration(
  job: PendingNovelMigration,
): Promise<void> {
  await writeContentSyncCache(
    migrationCacheKey(job.operationId),
    JSON.stringify({
      ...job,
      serverUrl: normalizeContentServerUrl(job.serverUrl),
    }),
  );
}

export async function isNovelMigrationSourceHeld(
  serverUrl: string,
  identity: MigrationWorkIdentity,
): Promise<boolean> {
  if (!serverUrl.trim()) return false;
  return invokeDbQuery<boolean>("db_content_sync_is_migration_source_held", {
    serverUrl,
    identity,
    readMode: "queued",
  });
}
