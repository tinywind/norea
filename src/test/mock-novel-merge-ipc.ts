import type { TestSqliteDatabase as Database } from "./sql/types";
import {
  getChapterComposition,
  materializeChapterComposition,
  setChapterComposition,
} from "./sql/chapter-composition";
import type { DatabaseReadMode } from "../db/client";
import type { DbMutationEnvelope } from "../db/ipc";
import type {
  ApplyNovelMergeInput,
  IncomingMigrationCommit,
  NovelMergeDatabaseResult,
} from "../db/queries/novel-merge";
import { sqliteBoolean } from "./sql/sqlite-value";
import { deferUserStateForNovelInDb } from "./sql/user-state-materialize";
import {
  hasUserStateSchema,
  recordChaptersInDb,
  recordCompositionInDb,
  recordMembershipInDb,
  recordPublicNovelReadingInDb,
} from "./sql/user-state-core";
import {
  remapPendingUserStateInDb,
  transferSettledNovelMergeResumeInDb,
} from "./sql/user-state-migration";
import { flushWorkMetadata, persistWorkChapterDirectories } from "./sql/work-metadata";
import { bytesToBase64, base64ToBytes } from "../lib/base64";
import { chapterCompositionCatalog, type ChapterCompositionV1 } from "../lib/chapter-composition";
import { isKnownChapterContentType, type ChapterContentType } from "../lib/chapter-content";
import type { ChapterStorageTransferEntry } from "../lib/chapter-storage-transfer";
import { normalizeContentServerUrl } from "../lib/content-sync/client";
import { incomingMigrationFromLineage } from "../lib/content-sync/migration-feed-state";
import {
  listIncomingMigrationsInTestDb,
  recordPendingNovelMergeInTestDb,
  releaseMigratedTargetMetadataInTestDb,
  saveIncomingMigrationInTestDb,
} from "./mock-content-sync-ipc";
import {
  parseNovelMergeStorageJournal,
  type MergeStorageWork,
  type NovelMergeStorageJournal,
} from "../lib/novel-merge-storage";

interface CreateNovelMergeStorageJournalInputForTest {
  token?: string;
  source: MergeStorageWork;
  sourceDirectory: string;
  sourceMetadataBody: string | null;
  target: MergeStorageWork;
  targetDirectory: string;
  targetMetadataBody: string | null;
  entries: ChapterStorageTransferEntry[];
  cleanupDirectories: string[];
  composition?: ChapterCompositionV1;
}
import {
  assertSourceChapterNumberChangesSupported,
  canonicalChapterNumber,
  parseSourceChapterRenumberJournal,
  renumberJournalKey,
  SERVER_CHAPTER_RENUMBER_PREFIX,
  SOURCE_CHAPTER_RENUMBER_PREFIX,
  type ChapterRenumberMetadataFile,
  type RenumberWork,
  type ServerChapterRenumberJob,
  type SourceChapterNumberChange,
  type SourceChapterRenumberJournal,
  type StoredRenumberChapter,
} from "../lib/source-chapter-renumber";
import { parseNovelMetadata } from "../lib/work-metadata/schema";

const NOVEL_MERGE_STORAGE_PREFIX = "norea-novel-merge-storage:";
const SQLITE_BIND_PARAMETER_BUDGET = 900;
const NOVEL_MERGE_UPDATE_PARAM_COUNT = 10;
const NOVEL_MERGE_UPDATE_CHUNK_SIZE = Math.floor(
  SQLITE_BIND_PARAMETER_BUDGET / NOVEL_MERGE_UPDATE_PARAM_COUNT,
);

export interface NovelMergeIpcBridgeOptions {
  getDb: () => Database | Promise<Database>;
  getReadOnlyDb?: () =>
    | Pick<Database, "select">
    | Promise<Pick<Database, "select">>;
  runTransaction: (
    run: (db: Database) => Promise<any>,
    remoteContentSync?: boolean,
  ) => Promise<any>;
}

export async function readRenumberChaptersInDb(
  db: Pick<Database, "select">,
  novelId: number,
): Promise<StoredRenumberChapter[]> {
  return db.select<StoredRenumberChapter[]>(
    "SELECT c.id,c.path,c.chapter_number AS chapterNumber,c.position,c.is_downloaded AS isDownloaded,d.directory " +
      "FROM chapter c LEFT JOIN work_metadata_directory_cache d ON d.chapter_id=c.id WHERE c.novel_id=$1 ORDER BY c.id",
    [novelId],
  );
}

export async function applySourceChapterNumberChangesInDb(
  db: Database,
  novelId: number,
  job: SourceChapterRenumberJournal,
): Promise<void> {
  if (job.work.id !== novelId || job.phase !== "preparing") {
    throw new Error("Chapter number reconciliation no longer matches this work.");
  }
  const current = await readRenumberChaptersInDb(db, novelId);
  for (const change of job.changes) {
    const chapter = current.find((row) => row.id === change.id);
    if (
      !chapter ||
      chapter.path !== change.path ||
      canonicalChapterNumber(chapter.chapterNumber) !== change.chapterNumber ||
      current.some(
        (row) =>
          row.id !== change.id &&
          (row.path === change.nextPath ||
            canonicalChapterNumber(row.chapterNumber) ===
              change.nextChapterNumber),
      )
    ) {
      throw new Error(
        "A chapter changed while its number was being reconciled; existing files were retained.",
      );
    }
  }
  for (const change of job.changes) {
    await db.execute(
      "UPDATE chapter SET path=$1,chapter_number=$2,updated_at=unixepoch() WHERE id=$3 AND novel_id=$4",
      [change.nextPath, change.nextChapterNumber, change.id, novelId],
    );
  }
  const changed = new Map(
    job.changes.map((change) => [change.id, change.targetRelativeDir]),
  );
  const directories = current.flatMap((chapter) => {
    const directory = changed.get(chapter.id) ?? chapter.directory;
    return directory ? [{ id: chapter.id, directory }] : [];
  });
  await persistWorkChapterDirectories(db, novelId, directories);
  const rows = await db.select<{ key: string; payload: string }[]>(
    "SELECT cache_key AS key,payload FROM content_sync_cache WHERE cache_key LIKE 'norea-content-deletions:%'",
  );
  const replacements = new Map(
    job.changes.map((change) => [change.chapterNumber, change.nextChapterNumber]),
  );
  for (const row of rows) {
    const exclusions = JSON.parse(row.payload) as string[];
    if (!Array.isArray(exclusions)) {
      throw new Error("Stored chapter deletion exclusions are invalid.");
    }
    let changedExclusions = false;
    const next = exclusions.map((value) => {
      const key: unknown = JSON.parse(value);
      if (
        !Array.isArray(key) ||
        key.length !== 3 ||
        key[0] !== job.work.pluginId ||
        key[1] !== job.work.sourceNovelId ||
        !Array.isArray(key[2]) ||
        key[2][0] !== "number"
      ) {
        return value;
      }
      const number = canonicalChapterNumber(key[2][1]);
      const replacement = number === null ? undefined : replacements.get(number);
      if (replacement === undefined) return value;
      changedExclusions = true;
      return JSON.stringify([key[0], key[1], ["number", Number(replacement)]]);
    });
    if (changedExclusions) {
      await db.execute(
        "UPDATE content_sync_cache SET payload=$1 WHERE cache_key=$2",
        [JSON.stringify([...new Set(next)]), row.key],
      );
    }
  }
}

export async function commitSourceChapterRenumberInDb(
  db: Database,
  job: SourceChapterRenumberJournal,
): Promise<void> {
  const committed = { ...job, phase: "committed" as const };
  await db.execute(
    "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
    [renumberJournalKey(committed.operationId), JSON.stringify(committed)],
  );
  if (job.serverUrl) {
    const remote: ServerChapterRenumberJob = {
      version: 1,
      operationId: job.operationId,
      serverUrl: job.serverUrl,
      identity: {
        pluginId: job.work.pluginId,
        novelId: job.work.sourceNovelId,
        novelPath: job.work.path,
      },
      mappings: job.changes.map((change) => ({
        chapterPath: change.nextPath,
        from: change.chapterNumber,
        to: change.nextChapterNumber,
      })),
      status: "pending",
      createdAt: Date.now(),
    };
    await db.execute(
      "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2)",
      [SERVER_CHAPTER_RENUMBER_PREFIX + job.operationId, JSON.stringify(remote)],
    );
  }
}

export async function commitNovelMergeStorageInDb(
  db: Pick<Database, "execute">,
  token: string,
): Promise<void> {
  const result = await db.execute(
    "UPDATE content_sync_cache SET payload=json_set(payload,'$.phase','committed') WHERE cache_key=$1 AND json_extract(payload,'$.phase')='preparing'",
    [NOVEL_MERGE_STORAGE_PREFIX + token],
  );
  if (result.rowsAffected !== 1) {
    throw new Error("Work merge storage journal changed before commit.");
  }
}

export async function commitIncomingMigrationInDb(
  db: Database,
  commit: IncomingMigrationCommit,
): Promise<void> {
  const server = normalizeContentServerUrl(commit.serverUrl);
  const savedChain = new Map(
    (await listIncomingMigrationsInTestDb(db, server, true)).map((value) => [
      value.operationId,
      value,
    ]),
  );
  for (const edge of commit.chain) {
    const savedEdge = savedChain.get(edge.operationId);
    if (!savedEdge || savedEdge.sequence !== edge.sequence || !savedEdge.lineage.active) {
      throw new Error(
        "The received work migration chain changed before its local commit.",
      );
    }
    incomingMigrationFromLineage(server, edge, savedEdge);
  }
  const current = savedChain.get(commit.expectedOperationId);
  if (
    !current ||
    current.sequence !== commit.expectedSequence ||
    current.status !== "pending" ||
    !current.lineage.active
  ) {
    throw new Error(
      "The received work migration changed before its local commit.",
    );
  }
  if (commit.releaseTargetWork) {
    await releaseMigratedTargetMetadataInTestDb(db, server, {
      pluginId: commit.releaseTargetWork.pluginId,
      novelId: "",
      novelPath: commit.releaseTargetWork.novelPath,
    });
  }
  await saveIncomingMigrationInTestDb(db, {
    ...current,
    status: "completed",
    error: undefined,
  });
}

interface NovelMergeNovelRow {
  id: number;
  pluginId: string;
  inLibrary: unknown;
  isLocal: unknown;
  libraryAddedAt: number | null;
  lastReadAt: number | null;
}

interface NovelMergeChapterRow {
  id: number;
  novelId: number;
  path: string;
  bookmark: unknown;
  unread: unknown;
  progress: number;
  isDownloaded: unknown;
  sourceContentType: ChapterContentType;
  contentType: ChapterContentType;
  contentBytes: number;
  mediaBytes: number;
  mediaRepairNeeded: unknown;
  mediaBytesCheckedAt: number | null;
  readAt: number | null;
}

function latestTimestamp(values: readonly (number | null)[]): number | null {
  const timestamps = values.filter((value): value is number => value != null);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function booleanParam(value: boolean): number {
  return value ? 1 : 0;
}

async function applyNovelMergeTx(
  db: Database,
  input: ApplyNovelMergeInput,
): Promise<NovelMergeDatabaseResult> {
  const {
    contentSyncServerUrl,
    contentSyncSourceSnapshot,
    contentSyncTargetMetadata,
    incomingMigrationCommit,
    storageTransferToken,
    decisions,
    preparedDownloads,
    composition,
    preparedCompositionCopies,
    readingStateSourcePathByTargetPath,
    skipSourceContentChapterIds,
    sourceNovelId,
    targetNovelId,
  } = input;

  if (incomingMigrationCommit && contentSyncServerUrl) {
    throw new Error("An incoming migration cannot create an outgoing migration.");
  }

  const novels = await db.select<NovelMergeNovelRow[]>(
    `SELECT
       id,
       plugin_id AS pluginId,
       in_library AS inLibrary,
       is_local AS isLocal,
       library_added_at AS libraryAddedAt,
       last_read_at AS lastReadAt
     FROM novel
     WHERE id IN ($1, $2)`,
    [sourceNovelId, targetNovelId],
  );
  const sourceNovel = novels.find((novel) => novel.id === sourceNovelId);
  const targetNovel = novels.find((novel) => novel.id === targetNovelId);
  if (!sourceNovel || !targetNovel) {
    throw new Error("Source or target novel no longer exists.");
  }
  if (
    sourceNovel.pluginId === "local" ||
    sqliteBoolean(sourceNovel.isLocal) ||
    targetNovel.pluginId === "local" ||
    sqliteBoolean(targetNovel.isLocal)
  ) {
    throw new Error("Novel merge supports remote novels only.");
  }

  if (composition) {
    await materializeChapterComposition(db, targetNovelId, composition, {
      preparedCopies: preparedCompositionCopies,
    });
  }

  const chapters = await db.select<NovelMergeChapterRow[]>(
    `SELECT
       id,
       novel_id AS novelId,
       path,
       bookmark,
       unread,
       progress,
       is_downloaded AS isDownloaded,
       content_type AS sourceContentType,
       COALESCE(stored_content_type, content_type) AS contentType,
       content_bytes AS contentBytes,
       media_bytes AS mediaBytes,
       media_repair_needed AS mediaRepairNeeded,
       media_bytes_checked_at AS mediaBytesCheckedAt,
       read_at AS readAt
     FROM chapter
     WHERE novel_id IN ($1, $2)
     ORDER BY position, id`,
    [sourceNovelId, targetNovelId],
  );
  const sourceChapters = chapters.filter(
    (chapter) => chapter.novelId === sourceNovelId,
  );
  const targetChapters = chapters.filter(
    (chapter) => chapter.novelId === targetNovelId,
  );
  const sourceById = new Map(
    sourceChapters.map((chapter) => [chapter.id, chapter]),
  );
  const targetByPath = new Map(
    targetChapters.map((chapter) => [chapter.path, chapter]),
  );

  const decisionBySourceId = new Map<
    number,
    ApplyNovelMergeInput["decisions"][number]
  >();
  const sourcesByTargetId = new Map<number, NovelMergeChapterRow[]>();
  const chapterIdMap: Record<number, number> = {};

  for (const decision of decisions) {
    if (decisionBySourceId.has(decision.sourceChapterId)) {
      throw new Error("Each source chapter must have exactly one decision.");
    }
    const sourceChapter = sourceById.get(decision.sourceChapterId);
    if (!sourceChapter) {
      throw new Error(
        "A decision references a source chapter that no longer exists.",
      );
    }
    decisionBySourceId.set(decision.sourceChapterId, decision);

    if (decision.kind === "exclude") continue;
    const targetChapter = targetByPath.get(decision.targetChapterPath);
    if (!targetChapter) {
      throw new Error("Target chapter no longer exists.");
    }
    chapterIdMap[sourceChapter.id] = targetChapter.id;
    const mappedSources = sourcesByTargetId.get(targetChapter.id) ?? [];
    mappedSources.push(sourceChapter);
    sourcesByTargetId.set(targetChapter.id, mappedSources);
  }

  if (
    decisionBySourceId.size !== sourceChapters.length ||
    sourceChapters.some((chapter) => !decisionBySourceId.has(chapter.id))
  ) {
    throw new Error(
      "Every source chapter must have one decision before merging.",
    );
  }

  const preparedByTargetId = new Map<
    number,
    ApplyNovelMergeInput["preparedDownloads"][number]
  >();
  let transferredDownloads = 0;

  for (const prepared of preparedDownloads) {
    const decision = decisionBySourceId.get(prepared.sourceChapterId);
    if (!decision || decision.kind !== "map") {
      throw new Error(
        "Prepared download metadata must reference a mapped source chapter.",
      );
    }
    if (!isKnownChapterContentType(prepared.contentType)) {
      throw new Error(
        `Prepared download content type is unsupported: ${String(
          prepared.contentType,
        )}`,
      );
    }
    if (
      !Number.isSafeInteger(prepared.contentBytes) ||
      prepared.contentBytes < 0 ||
      !Number.isSafeInteger(prepared.mediaBytes) ||
      prepared.mediaBytes < 0
    ) {
      throw new Error("Prepared download byte counts must be non-negative integers.");
    }
    const targetChapter = targetByPath.get(decision.targetChapterPath)!;
    if (preparedByTargetId.has(targetChapter.id)) {
      throw new Error(
        "At most one A download may be prepared for a single B chapter.",
      );
    }
    preparedByTargetId.set(targetChapter.id, prepared);
    if (prepared.transferredFromSource) {
      transferredDownloads += 1;
    }
  }

  await db.execute(
    `DELETE FROM chapter_download_queue
     WHERE chapter_id IN (SELECT id FROM chapter WHERE novel_id IN ($1, $2))`,
    [sourceNovelId, targetNovelId],
  );
  await db.execute(
    `INSERT OR IGNORE INTO novel_category (novel_id, category_id)
     SELECT $1, category_id
     FROM novel_category
     WHERE novel_id = $2`,
    [targetNovelId, sourceNovelId],
  );
  await db.execute(
    `INSERT OR IGNORE INTO novel_download_goal (novel_id, kind, count, updated_at)
     SELECT $1, kind, count, updated_at
     FROM novel_download_goal
     WHERE novel_id = $2`,
    [targetNovelId, sourceNovelId],
  );
  const chapterMappings = Object.entries(chapterIdMap)
    .map(([src, tgt]) => [Number(src), tgt] as const)
    .sort((a, b) => a[0] - b[0]);
  for (let offset = 0; offset < chapterMappings.length; offset += 450) {
    const chunk = chapterMappings.slice(offset, offset + 450);
    const valuesSql = chunk
      .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
      .join(", ");
    await db.execute(
      `WITH chapter_mappings (source_id, target_id) AS (VALUES ${valuesSql})
       INSERT OR IGNORE INTO chapter_download_goal_exclusion (chapter_id, created_at)
       SELECT mapping.target_id, MIN(exclusion.created_at)
       FROM chapter_mappings AS mapping
       JOIN chapter_download_goal_exclusion AS exclusion ON exclusion.chapter_id = mapping.source_id
       GROUP BY mapping.target_id`,
      chunk.flatMap(([src, tgt]) => [src, tgt]),
    );
  }

  const mergedReadAtByTargetId = new Map<number, number | null>();
  const chapterUpdates: Array<{
    applyDownloadMetadata: number;
    bookmark: number;
    contentBytes: number;
    contentType: ChapterContentType | null;
    id: number;
    mediaBytes: number;
    mediaComplete: number;
    progress: number;
    readAt: number | null;
    unread: number;
  }> = [];

  for (const [targetId, mappedSources] of sourcesByTargetId) {
    const targetChapter = targetChapters.find((chapter) => chapter.id === targetId)!;
    const mergedState = {
      bookmark:
        sqliteBoolean(targetChapter.bookmark) ||
        mappedSources.some((source) => sqliteBoolean(source.bookmark)),
      unread:
        sqliteBoolean(targetChapter.unread) &&
        mappedSources.every((source) => sqliteBoolean(source.unread)),
      progress: Math.max(
        targetChapter.progress,
        ...mappedSources.map((source) => source.progress),
      ),
      readAt: latestTimestamp([
        targetChapter.readAt,
        ...mappedSources.map((source) => source.readAt),
      ]),
    };
    mergedReadAtByTargetId.set(targetId, mergedState.readAt);
    const prepared = preparedByTargetId.get(targetId);
    const selectedSource = prepared
      ? sourceById.get(prepared.sourceChapterId)
      : undefined;
    const mediaComplete = prepared
      ? prepared.mediaComplete !== undefined
        ? prepared.mediaComplete
        : prepared.transferredFromSource
          ? !sqliteBoolean(selectedSource?.mediaRepairNeeded)
          : !sqliteBoolean(targetChapter.mediaRepairNeeded)
      : true;
    const applyDownloadMetadata =
      prepared &&
      (prepared.transferredFromSource ||
        !sqliteBoolean(targetChapter.isDownloaded) ||
        targetChapter.mediaBytesCheckedAt === null ||
        Boolean(sqliteBoolean(targetChapter.mediaRepairNeeded)) !==
          !mediaComplete);

    chapterUpdates.push({
      id: targetId,
      bookmark: booleanParam(mergedState.bookmark),
      unread: booleanParam(mergedState.unread),
      progress: mergedState.progress,
      readAt: mergedState.readAt,
      applyDownloadMetadata: booleanParam(Boolean(applyDownloadMetadata)),
      contentType: applyDownloadMetadata ? prepared!.contentType : null,
      contentBytes: applyDownloadMetadata ? prepared!.contentBytes : 0,
      mediaBytes: applyDownloadMetadata ? prepared!.mediaBytes : 0,
      mediaComplete: booleanParam(mediaComplete),
    });
  }

  for (
    let offset = 0;
    offset < chapterUpdates.length;
    offset += NOVEL_MERGE_UPDATE_CHUNK_SIZE
  ) {
    const chunk = chapterUpdates.slice(
      offset,
      offset + NOVEL_MERGE_UPDATE_CHUNK_SIZE,
    );
    const valuesSql = chunk
      .map((_, index) => {
        const base = index * NOVEL_MERGE_UPDATE_PARAM_COUNT;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
      })
      .join(", ");
    const params = chunk.flatMap((row) => [
      row.id,
      row.bookmark,
      row.unread,
      row.progress,
      row.readAt,
      row.applyDownloadMetadata,
      row.contentType,
      row.contentBytes,
      row.mediaBytes,
      row.mediaComplete,
    ]);

    await db.execute(
      `WITH merge_updates(
         id,
         bookmark,
         unread,
         progress,
         read_at,
         apply_download_metadata,
         content_type,
         content_bytes,
         media_bytes,
         media_complete
       ) AS (
         VALUES ${valuesSql}
       )
       UPDATE chapter
       SET
         bookmark = (SELECT bookmark FROM merge_updates WHERE merge_updates.id = chapter.id),
         unread = (SELECT unread FROM merge_updates WHERE merge_updates.id = chapter.id),
         progress = (SELECT progress FROM merge_updates WHERE merge_updates.id = chapter.id),
         read_at = (SELECT read_at FROM merge_updates WHERE merge_updates.id = chapter.id),
         is_downloaded = CASE
           WHEN (SELECT apply_download_metadata FROM merge_updates WHERE merge_updates.id = chapter.id) = 1
             THEN (SELECT media_complete FROM merge_updates WHERE merge_updates.id = chapter.id)
           ELSE chapter.is_downloaded
         END,
         stored_content_type = CASE
           WHEN (SELECT apply_download_metadata FROM merge_updates WHERE merge_updates.id = chapter.id) = 1
             THEN (SELECT content_type FROM merge_updates WHERE merge_updates.id = chapter.id)
           ELSE chapter.stored_content_type
         END,
         content_bytes = CASE
           WHEN (SELECT apply_download_metadata FROM merge_updates WHERE merge_updates.id = chapter.id) = 1
             THEN (SELECT content_bytes FROM merge_updates WHERE merge_updates.id = chapter.id)
           ELSE chapter.content_bytes
         END,
         media_bytes = CASE
           WHEN (SELECT apply_download_metadata FROM merge_updates WHERE merge_updates.id = chapter.id) = 1
             THEN (SELECT media_bytes FROM merge_updates WHERE merge_updates.id = chapter.id)
           ELSE chapter.media_bytes
         END,
         media_repair_needed = CASE
           WHEN (SELECT apply_download_metadata FROM merge_updates WHERE merge_updates.id = chapter.id) = 1
             THEN CASE WHEN (SELECT media_complete FROM merge_updates WHERE merge_updates.id = chapter.id) = 1 THEN 0 ELSE 1 END
           ELSE chapter.media_repair_needed
         END,
         media_bytes_checked_at = CASE
           WHEN (SELECT apply_download_metadata FROM merge_updates WHERE merge_updates.id = chapter.id) = 1
             THEN unixepoch()
           ELSE chapter.media_bytes_checked_at
         END,
         updated_at = unixepoch()
       WHERE id IN (SELECT id FROM merge_updates)`,
      params,
    );
  }

  if (composition) {
    await setChapterComposition(db, targetNovelId, composition);
  }

  const mergedLastReadAt = latestTimestamp([
    targetNovel.lastReadAt,
    ...mergedReadAtByTargetId.values(),
  ]);
  await db.execute(
    `UPDATE novel
     SET
       in_library = CASE
         WHEN in_library = 1 OR $2 = 1 THEN 1
         ELSE 0
       END,
       library_added_at = CASE
         WHEN in_library = 1 AND $2 = 1 THEN
           CASE
             WHEN library_added_at IS NULL THEN COALESCE($3, unixepoch())
             WHEN $3 IS NULL THEN library_added_at
             ELSE MIN(library_added_at, $3)
           END
         WHEN in_library = 1 THEN COALESCE(library_added_at, unixepoch())
         WHEN $2 = 1 THEN COALESCE($3, unixepoch())
         ELSE NULL
       END,
       last_read_at = $4,
       updated_at = unixepoch()
     WHERE id = $1`,
    [
      targetNovelId,
      booleanParam(sqliteBoolean(sourceNovel.inLibrary)),
      sourceNovel.libraryAddedAt,
      mergedLastReadAt,
    ],
  );

  let preferredLastReadChapterId: number | null =
    [...mergedReadAtByTargetId.entries()]
      .filter((entry): entry is [number, number] => entry[1] != null)
      .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;

  if (contentSyncServerUrl) {
    await recordPendingNovelMergeInTestDb(db, {
      serverUrl: contentSyncServerUrl,
      sourceSnapshot: contentSyncSourceSnapshot,
      targetMetadata: contentSyncTargetMetadata,
      sourceNovelId,
      targetNovelId,
      chapterIdMap,
      preparedDownloads,
      skipSourceContentChapterIds,
    });
  }

  const remappedState = await remapPendingUserStateInDb(
    db,
    sourceNovelId,
    targetNovelId,
    chapterIdMap,
    readingStateSourcePathByTargetPath,
  );
  const explicitResume = remappedState.resumes.at(-1);
  if (explicitResume) preferredLastReadChapterId = explicitResume.chapterId;
  if (!incomingMigrationCommit) {
    const settledResume = await transferSettledNovelMergeResumeInDb(
      db,
      sourceNovelId,
      targetNovelId,
      chapterIdMap,
      Boolean(explicitResume),
    );
    if (settledResume) preferredLastReadChapterId = settledResume.chapterId;
    await recordPublicNovelReadingInDb(db, [targetNovelId]);
    if (await hasUserStateSchema(db)) {
      const targetIds = await db.select<{ id: number }[]>(
        "SELECT id FROM chapter WHERE novel_id=$1",
        [targetNovelId],
      );
      await recordChaptersInDb(
        db,
        targetIds.map((row) => row.id),
        "bookmark",
      );
      const categories = await db.select<{ id: number }[]>(
        "SELECT category_id AS id FROM novel_category WHERE novel_id=$1",
        [targetNovelId],
      );
      for (const category of categories) {
        await recordMembershipInDb(db, [targetNovelId], category.id, true);
      }
    }
    await recordCompositionInDb(db, targetNovelId);
  } else {
    await deferUserStateForNovelInDb(db, targetNovelId);
  }
  if (incomingMigrationCommit) {
    await commitIncomingMigrationInDb(db, incomingMigrationCommit);
  }
  if (storageTransferToken) {
    await commitNovelMergeStorageInDb(db, storageTransferToken);
  }

  if (await hasUserStateSchema(db)) {
    const [srcRef] = await db.select<{ pluginId: string; sourceNovelId: string | null; path: string }[]>(
      "SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE id = $1",
      [sourceNovelId],
    );
    if (srcRef) {
      await db.execute(
        `UPDATE user_state_record
         SET applied_revision = revision, deferred_reason = NULL, deferred_detail = NULL
         WHERE (applied_revision < revision OR deferred_reason IS NOT NULL)
           AND json_extract(payload, '$.entity.work.pluginId') = $1
           AND (json_extract(payload, '$.entity.work.novelPath') = $3
                OR ($2 IS NOT NULL AND lower(json_extract(payload, '$.entity.work.sourceNovelId')) = lower($2)))`,
        [srcRef.pluginId, srcRef.sourceNovelId, srcRef.path],
      );
    }
  }

  const deleteResult = await db.execute("DELETE FROM novel WHERE id = $1", [
    sourceNovelId,
  ]);
  if (deleteResult.rowsAffected !== 1) {
    throw new Error("Source novel changed before it could be deleted.");
  }

  return {
    targetNovelId,
    chapterIdMap,
    preferredLastReadChapterId,
    transferredDownloads,
  };
}

export function createNovelMergeIpcHandler(
  options: NovelMergeIpcBridgeOptions,
) {
  const selectDb = async (readMode?: DatabaseReadMode) =>
    readMode === "committed" && options.getReadOnlyDb
      ? options.getReadOnlyDb()
      : options.getDb();

  return {
    async handle(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<{ handled: true; result: unknown } | { handled: false }> {
      if (command === "db_chapter_composition_get") {
        const db = await selectDb(
          args.readMode as DatabaseReadMode | undefined,
        );
        return {
          handled: true,
          result: await getChapterComposition(db, Number(args.novelId)),
        };
      }

      if (command === "db_novel_merge_find_target_preview") {
        const db = await selectDb(
          args.readMode as DatabaseReadMode | undefined,
        );
        const [novel] = await db.select<{ id: number }[]>(
          "SELECT id FROM novel WHERE plugin_id=$1 AND (path=$2 OR source_novel_id=$3) ORDER BY CASE WHEN path=$2 THEN 0 ELSE 1 END LIMIT 1",
          [args.pluginId, args.path, args.sourceNovelId],
        );
        if (!novel) return { handled: true, result: null };
        const composition = await getChapterComposition(db, novel.id);
        return {
          handled: true,
          result: { novelId: novel.id, composition },
        };
      }

      if (command === "db_novel_merge_create_storage_journal") {
        const input = args.input as CreateNovelMergeStorageJournalInputForTest;
        const value = await options.runTransaction(async (db) => {
          const [srcCached] = await db.select<{ fingerprint: string }[]>(
            "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id=$1",
            [input.source.id],
          );
          const [tgtCached] = await db.select<{ fingerprint: string }[]>(
            "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id=$1",
            [input.target.id],
          );
          let nextTargetMetadataBody = input.targetMetadataBody ?? null;
          if (input.composition) {
            if (!input.targetMetadataBody) {
              throw new Error(
                "Target work metadata is missing before its folder move.",
              );
            }
            const metadata = parseNovelMetadata(
              JSON.parse(
                new TextDecoder().decode(
                  base64ToBytes(input.targetMetadataBody),
                ),
              ),
            );
            nextTargetMetadataBody = bytesToBase64(
              new TextEncoder().encode(
                JSON.stringify({
                  ...metadata,
                  chapterComposition: input.composition,
                  chapters: chapterCompositionCatalog(input.composition),
                }),
              ),
            );
          }
          const job: NovelMergeStorageJournal = {
            version: 1,
            token: input.token ?? crypto.randomUUID(),
            phase: "preparing",
            source: {
              ...input.source,
              directory: input.sourceDirectory,
              metadataBody: input.sourceMetadataBody ?? null,
              nextMetadataBody: null,
              fingerprint: srcCached?.fingerprint ?? null,
            },
            target: {
              ...input.target,
              directory: input.targetDirectory,
              metadataBody: input.targetMetadataBody ?? null,
              nextMetadataBody: nextTargetMetadataBody,
              fingerprint: tgtCached?.fingerprint ?? null,
            },
            entries: input.entries,
            cleanupDirectories: [
              ...new Set(
                input.cleanupDirectories.map((path) =>
                  path.split("/").slice(0, 3).join("/"),
                ),
              ),
            ],
          };
          parseNovelMergeStorageJournal(JSON.stringify(job));
          await db.execute(
            "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
            [NOVEL_MERGE_STORAGE_PREFIX + job.token, JSON.stringify(job)],
          );
          return job;
        });
        return {
          handled: true,
          result: { value, effects: {} } satisfies DbMutationEnvelope<NovelMergeStorageJournal>,
        };
      }

      if (command === "db_novel_merge_save_storage_preparation") {
        await options.runTransaction(async (db) => {
          const updated: NovelMergeStorageJournal = {
            ...(args.job as NovelMergeStorageJournal),
            preparation: args.preparation as NovelMergeStorageJournal["preparation"],
          };
          parseNovelMergeStorageJournal(JSON.stringify(updated));
          await db.execute(
            "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
            [
              NOVEL_MERGE_STORAGE_PREFIX + updated.token,
              JSON.stringify(updated),
            ],
          );
        });
        return {
          handled: true,
          result: { value: undefined, effects: {} },
        };
      }

      if (command === "db_novel_merge_commit_storage_journal") {
        await options.runTransaction((db) =>
          commitNovelMergeStorageInDb(db, String(args.token)),
        );
        return {
          handled: true,
          result: { value: undefined, effects: {} },
        };
      }

      if (command === "db_novel_merge_list_storage_journals") {
        const db = await selectDb(
          args.readMode as DatabaseReadMode | undefined,
        );
        const workIds = args.workIds as number[] | null | undefined;
        const rows = await db.select<{ payload: string }[]>(
          "SELECT payload FROM content_sync_cache WHERE cache_key LIKE $1" +
            (workIds
              ? " AND (json_extract(payload,'$.source.id') IN (SELECT value FROM json_each($2)) OR json_extract(payload,'$.target.id') IN (SELECT value FROM json_each($2)))"
              : "") +
            " ORDER BY cache_key",
          workIds
            ? [NOVEL_MERGE_STORAGE_PREFIX + "%", JSON.stringify(workIds)]
            : [NOVEL_MERGE_STORAGE_PREFIX + "%"],
        );
        return {
          handled: true,
          result: rows.map((row) => row.payload),
        };
      }

      if (command === "db_novel_merge_verify_storage_recovery") {
        const db = await selectDb(
          args.readMode as DatabaseReadMode | undefined,
        );
        const token = String(args.token);
        const [row] = await db.select<{ payload: string }[]>(
          "SELECT payload FROM content_sync_cache WHERE cache_key=$1",
          [NOVEL_MERGE_STORAGE_PREFIX + token],
        );
        if (!row) return { handled: true, result: null };
        const job = parseNovelMergeStorageJournal(row.payload);
        if (job.token !== token) {
          throw new Error(
            "Work merge storage journal token does not match its key.",
          );
        }
        for (const work of [job.source, job.target]) {
          const [current] = await db.select<
            Array<{
              id: number;
              pluginId: string;
              sourceNovelId: string | null;
              path: string;
            }>
          >(
            "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE id=$1",
            [work.id],
          );
          if (job.phase === "committed" && work.id === job.source.id) {
            if (current) {
              throw new Error(
                "Committed work merge storage recovery still has its source work.",
              );
            }
          } else if (
            !current ||
            current.pluginId !== work.pluginId ||
            current.sourceNovelId !== work.sourceNovelId ||
            current.path !== work.path
          ) {
            throw new Error(
              "Work merge storage recovery identity changed. Existing files were retained.",
            );
          }
          if (job.phase === "preparing") {
            const [cached] = await db.select<{ fingerprint: string }[]>(
              "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id=$1",
              [work.id],
            );
            if ((cached?.fingerprint ?? null) !== work.fingerprint) {
              throw new Error(
                "Work merge metadata changed before recovery. Existing files were retained.",
              );
            }
          }
        }
        return { handled: true, result: job };
      }

      if (command === "db_novel_merge_delete_storage_journal") {
        const db = await options.getDb();
        await db.execute(
          "DELETE FROM content_sync_cache WHERE cache_key=$1",
          [NOVEL_MERGE_STORAGE_PREFIX + String(args.token)],
        );
        return {
          handled: true,
          result: { value: undefined, effects: {} },
        };
      }

      if (command === "db_novel_merge_apply") {
        const input = args.input as ApplyNovelMergeInput;
        const value = await options.runTransaction((db) =>
          applyNovelMergeTx(db, input),
        );
        return {
          handled: true,
          result: { value, effects: {} } satisfies DbMutationEnvelope<NovelMergeDatabaseResult>,
        };
      }

      if (command === "db_novel_merge_complete_incoming_migration") {
        const commit = args.commit as IncomingMigrationCommit;
        await options.runTransaction((db) =>
          commitIncomingMigrationInDb(db, commit),
        );
        return {
          handled: true,
          result: { value: undefined, effects: {} },
        };
      }

      if (command === "db_source_renumber_inspect_work") {
        const db = await selectDb(
          args.readMode as DatabaseReadMode | undefined,
        );
        const [work] = await db.select<
          Array<{
            id: number;
            pluginId: string;
            sourceNovelId: string | null;
            path: string;
          }>
        >(
          "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE plugin_id=$1 AND path=$2",
          [args.pluginId, args.path],
        );
        if (!work || !work.sourceNovelId) {
          return { handled: true, result: null };
        }
        const hasComposition =
          (await getChapterComposition(db, work.id)) !== null;
        const pendingRows = await db.select<{ payload: string }[]>(
          "SELECT payload FROM content_sync_cache WHERE cache_key LIKE $1 AND json_extract(payload,'$.work.id')=$2 ORDER BY cache_key",
          [SOURCE_CHAPTER_RENUMBER_PREFIX + "%", work.id],
        );
        const storedChapters = await readRenumberChaptersInDb(db, work.id);
        return {
          handled: true,
          result: {
            work: {
              id: work.id,
              pluginId: work.pluginId,
              sourceNovelId: work.sourceNovelId,
              path: work.path,
            },
            hasComposition,
            pendingJournalPayloads: pendingRows.map((row) => row.payload),
            storedChapters,
          },
        };
      }

      if (command === "db_source_renumber_read_chapters") {
        const db = await selectDb(
          args.readMode as DatabaseReadMode | undefined,
        );
        return {
          handled: true,
          result: await readRenumberChaptersInDb(db, Number(args.novelId)),
        };
      }

      if (command === "db_source_renumber_list_journals") {
        const db = await selectDb(
          args.readMode as DatabaseReadMode | undefined,
        );
        const workId = args.workId as number | null | undefined;
        const rows = await db.select<{ payload: string }[]>(
          workId != null
            ? "SELECT payload FROM content_sync_cache WHERE cache_key LIKE $1 AND json_extract(payload,'$.work.id')=$2 ORDER BY cache_key"
            : "SELECT payload FROM content_sync_cache WHERE cache_key LIKE $1 ORDER BY cache_key",
          workId != null
            ? [SOURCE_CHAPTER_RENUMBER_PREFIX + "%", workId]
            : [SOURCE_CHAPTER_RENUMBER_PREFIX + "%"],
        );
        return {
          handled: true,
          result: rows.map((row) => row.payload),
        };
      }

      if (command === "db_source_renumber_read_journal") {
        const db = await selectDb(
          args.readMode as DatabaseReadMode | undefined,
        );
        const [row] = await db.select<{ payload: string }[]>(
          "SELECT payload FROM content_sync_cache WHERE cache_key=$1",
          [renumberJournalKey(String(args.operationId))],
        );
        return {
          handled: true,
          result: row?.payload ?? null,
        };
      }

      if (command === "db_source_renumber_flush_and_read_work") {
        const input = args.input as {
          workId: number;
          pluginId: string;
          path: string;
          sourceNovelId: string;
        };
        const value = await options.runTransaction(async (db) => {
          const [current] = await db.select<RenumberWork[]>(
            "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE id=$1",
            [input.workId],
          );
          if (
            !current ||
            current.pluginId !== input.pluginId ||
            current.path !== input.path ||
            current.sourceNovelId !== input.sourceNovelId
          ) {
            throw new Error(
              "The work changed before its chapter numbers could be reconciled.",
            );
          }
          await flushWorkMetadata(db);
          const storedChapters = await readRenumberChaptersInDb(db, current.id);
          const [cached] = await db.select<{ fingerprint: string }[]>(
            "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id=$1",
            [current.id],
          );
          return {
            work: current,
            storedChapters,
            metadataFingerprint: cached?.fingerprint ?? null,
          };
        });
        return {
          handled: true,
          result: { value, effects: {} },
        };
      }

      if (command === "db_source_renumber_create_journal") {
        const input = args.input as {
          operationId?: string;
          work: RenumberWork;
          changes: SourceChapterNumberChange[];
          metadataBody: string | null;
          serverUrl: string | null;
          metadataFiles?: ChapterRenumberMetadataFile[];
          expectedFingerprint?: string | null;
        };
        const value = await options.runTransaction(async (db) => {
          assertSourceChapterNumberChangesSupported(input.changes);
          const [current] = await db.select<RenumberWork[]>(
            "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE id=$1",
            [input.work.id],
          );
          if (
            !current ||
            current.pluginId !== input.work.pluginId ||
            current.path !== input.work.path ||
            current.sourceNovelId !== input.work.sourceNovelId
          ) {
            throw new Error(
              "The work changed before its chapter numbers could be reconciled.",
            );
          }
          const [cached] = await db.select<{ fingerprint: string }[]>(
            "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id=$1",
            [input.work.id],
          );
          const fingerprint = cached?.fingerprint ?? null;
          if (
            input.expectedFingerprint !== undefined &&
            input.expectedFingerprint !== fingerprint
          ) {
            throw new Error(
              "Work metadata changed before chapter reconciliation could be prepared.",
            );
          }
          const job: SourceChapterRenumberJournal = {
            version: input.metadataFiles?.length ? 2 : 1,
            operationId: input.operationId ?? crypto.randomUUID(),
            phase: "preparing",
            work: input.work,
            changes: input.changes,
            metadataBody: input.metadataBody,
            metadataFingerprint: fingerprint,
            serverUrl: input.serverUrl,
            ...(input.metadataFiles?.length
              ? { metadataFiles: input.metadataFiles }
              : {}),
          };
          parseSourceChapterRenumberJournal(JSON.stringify(job));
          await db.execute(
            "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
            [renumberJournalKey(job.operationId), JSON.stringify(job)],
          );
          return job;
        });
        return {
          handled: true,
          result: { value, effects: {} },
        };
      }

      if (command === "db_source_renumber_save_journal") {
        const job = parseSourceChapterRenumberJournal(JSON.stringify(args.job));
        await options.runTransaction((db) =>
          db.execute(
            "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
            [renumberJournalKey(job.operationId), JSON.stringify(job)],
          ),
        );
        return {
          handled: true,
          result: { value: undefined, effects: {} },
        };
      }

      if (command === "db_source_renumber_apply_changes") {
        const job = parseSourceChapterRenumberJournal(JSON.stringify(args.job));
        await options.runTransaction((db) =>
          applySourceChapterNumberChangesInDb(db, Number(args.novelId), job),
        );
        return {
          handled: true,
          result: { value: [], effects: {} },
        };
      }

      if (command === "db_source_renumber_commit") {
        const job = parseSourceChapterRenumberJournal(JSON.stringify(args.job));
        await options.runTransaction((db) =>
          commitSourceChapterRenumberInDb(db, job),
        );
        return {
          handled: true,
          result: { value: undefined, effects: {} },
        };
      }

      if (command === "db_source_renumber_verify_recovery") {
        const db = await selectDb(
          args.readMode as DatabaseReadMode | undefined,
        );
        const job = parseSourceChapterRenumberJournal(JSON.stringify(args.job));
        const [work] = await db.select<RenumberWork[]>(
          "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE id=$1",
          [job.work.id],
        );
        const rows = await readRenumberChaptersInDb(db, job.work.id);
        const committed = job.phase === "committed";
        if (
          !work ||
          work.pluginId !== job.work.pluginId ||
          work.sourceNovelId !== job.work.sourceNovelId ||
          work.path !== job.work.path ||
          job.changes.some((change) => {
            const row = rows.find((current) => current.id === change.id);
            const expectedNumber = committed
              ? change.nextChapterNumber
              : change.chapterNumber;
            const expectedDirectory = committed
              ? change.targetRelativeDir
              : change.sourceRelativeDir;
            return (
              !row ||
              row.path !== (committed ? change.nextPath : change.path) ||
              canonicalChapterNumber(row.chapterNumber) !== expectedNumber ||
              (committed
                ? row.directory !== expectedDirectory
                : row.directory !== null && row.directory !== expectedDirectory)
            );
          })
        ) {
          throw new Error(
            "Chapter number recovery does not match the current database. Existing files were retained.",
          );
        }
        if (!committed) {
          const [cached] = await db.select<{ fingerprint: string }[]>(
            "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id=$1",
            [job.work.id],
          );
          if ((cached?.fingerprint ?? null) !== job.metadataFingerprint) {
            throw new Error(
              "Work metadata changed after chapter reconciliation was prepared. Existing files were retained.",
            );
          }
        }
        return { handled: true, result: null };
      }

      if (command === "db_source_renumber_delete_journal") {
        const db = await options.getDb();
        await db.execute(
          "DELETE FROM content_sync_cache WHERE cache_key=$1",
          [renumberJournalKey(String(args.operationId))],
        );
        return {
          handled: true,
          result: { value: undefined, effects: {} },
        };
      }

      return { handled: false };
    },
  };
}
