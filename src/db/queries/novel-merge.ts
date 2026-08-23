import {
  isKnownChapterContentType,
  type ChapterContentType,
} from "../../lib/chapter-content";
import { runDatabaseTransaction } from "../client";

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

export interface ApplyNovelMergeInput {
  sourceNovelId: number;
  targetNovelId: number;
  decisions: readonly NovelMergeChapterDecision[];
  preparedDownloads: readonly PreparedNovelMergeDownload[];
}

export interface PreparedNovelMergeDownload {
  sourceChapterId: number;
  contentType: ChapterContentType;
  contentBytes: number;
  mediaBytes: number;
  transferredFromSource: boolean;
}

export interface NovelMergeDatabaseResult {
  targetNovelId: number;
  chapterIdMap: Record<number, number>;
  preferredLastReadChapterId: number | null;
  transferredDownloads: number;
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

interface MergedTargetState {
  bookmark: boolean;
  unread: boolean;
  progress: number;
  readAt: number | null;
}

interface NovelMergeChapterUpdate {
  applyDownloadMetadata: number;
  bookmark: number;
  contentBytes: number;
  contentType: ChapterContentType | null;
  id: number;
  mediaBytes: number;
  progress: number;
  readAt: number | null;
  unread: number;
}

const SQLITE_BIND_PARAMETER_BUDGET = 900;
const NOVEL_MERGE_UPDATE_PARAM_COUNT = 9;
const NOVEL_MERGE_UPDATE_CHUNK_SIZE = Math.floor(
  SQLITE_BIND_PARAMETER_BUDGET / NOVEL_MERGE_UPDATE_PARAM_COUNT,
);

function sqliteBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  }
  return false;
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function latestTimestamp(values: readonly (number | null)[]): number | null {
  const timestamps = values.filter((value): value is number => value != null);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function mergeTargetState(
  target: NovelMergeChapterRow,
  sources: readonly NovelMergeChapterRow[],
): MergedTargetState {
  return {
    bookmark:
      sqliteBoolean(target.bookmark) ||
      sources.some((source) => sqliteBoolean(source.bookmark)),
    unread:
      sqliteBoolean(target.unread) &&
      sources.every((source) => sqliteBoolean(source.unread)),
    progress: Math.max(target.progress, ...sources.map((source) => source.progress)),
    readAt: latestTimestamp([
      target.readAt,
      ...sources.map((source) => source.readAt),
    ]),
  };
}

function booleanParam(value: boolean): number {
  return value ? 1 : 0;
}

export async function applyNovelMergeInDb({
  decisions,
  preparedDownloads,
  sourceNovelId,
  targetNovelId,
}: ApplyNovelMergeInput): Promise<NovelMergeDatabaseResult> {
  assertPositiveId(sourceNovelId, "Source novel id");
  assertPositiveId(targetNovelId, "Target novel id");
  if (sourceNovelId === targetNovelId) {
    throw new Error("Source and target novels must be different.");
  }

  return runDatabaseTransaction(async (db) => {
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
    if (sqliteBoolean(sourceNovel.isLocal) || sqliteBoolean(targetNovel.isLocal)) {
      throw new Error("Novel merge supports remote novels only.");
    }
    if (sourceNovel.pluginId === targetNovel.pluginId) {
      throw new Error("Novel merge requires different source plugins.");
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
       WHERE novel_id IN ($1, $2)`,
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

    const decisionBySourceId = new Map<number, NovelMergeChapterDecision>();
    for (const decision of decisions) {
      assertPositiveId(decision.sourceChapterId, "Source chapter id");
      if (decisionBySourceId.has(decision.sourceChapterId)) {
        throw new Error("Each source chapter must have exactly one decision.");
      }
      if (!sourceById.has(decision.sourceChapterId)) {
        throw new Error("A decision references a source chapter that no longer exists.");
      }
      if (decision.kind === "map" && !targetByPath.has(decision.targetChapterPath)) {
        throw new Error("Target chapter no longer exists.");
      }
      decisionBySourceId.set(decision.sourceChapterId, decision);
    }
    if (
      decisionBySourceId.size !== sourceChapters.length ||
      sourceChapters.some((chapter) => !decisionBySourceId.has(chapter.id))
    ) {
      throw new Error("Every source chapter must have one decision before merging.");
    }

    const mappedSourcesByTargetId = new Map<number, NovelMergeChapterRow[]>();
    const chapterIdMap: Record<number, number> = {};
    for (const source of sourceChapters) {
      const decision = decisionBySourceId.get(source.id)!;
      if (decision.kind === "exclude") continue;
      const target = targetByPath.get(decision.targetChapterPath)!;
      const mapped = mappedSourcesByTargetId.get(target.id) ?? [];
      mapped.push(source);
      mappedSourcesByTargetId.set(target.id, mapped);
      chapterIdMap[source.id] = target.id;
    }

    const preparedDownloadsBySourceId = new Map<
      number,
      PreparedNovelMergeDownload
    >();
    const preparedSourceIdByTargetId = new Map<number, number>();
    for (const prepared of preparedDownloads) {
      assertPositiveId(prepared.sourceChapterId, "Prepared source chapter id");
      if (preparedDownloadsBySourceId.has(prepared.sourceChapterId)) {
        throw new Error("Prepared source chapter ids must be unique.");
      }
      if (!isKnownChapterContentType(prepared.contentType)) {
        throw new Error("Prepared download content type is unsupported.");
      }
      if (typeof prepared.transferredFromSource !== "boolean") {
        throw new Error("Prepared download origin is invalid.");
      }
      if (
        !Number.isSafeInteger(prepared.contentBytes) ||
        prepared.contentBytes < 0 ||
        !Number.isSafeInteger(prepared.mediaBytes) ||
        prepared.mediaBytes < 0
      ) {
        throw new Error("Prepared download byte counts must be non-negative safe integers.");
      }
      const source = sourceById.get(prepared.sourceChapterId);
      const decision = decisionBySourceId.get(prepared.sourceChapterId);
      if (!source || decision?.kind !== "map") {
        throw new Error("Prepared content must belong to a mapped source chapter.");
      }
      if (
        prepared.transferredFromSource &&
        !sqliteBoolean(source.isDownloaded)
      ) {
        throw new Error("Transferred content must belong to a downloaded source chapter.");
      }
      const target = targetByPath.get(decision.targetChapterPath)!;
      if (preparedSourceIdByTargetId.has(target.id)) {
        throw new Error("Only one source download can be transferred to a target chapter.");
      }
      preparedDownloadsBySourceId.set(prepared.sourceChapterId, prepared);
      preparedSourceIdByTargetId.set(target.id, prepared.sourceChapterId);
    }

    await db.execute(
      `DELETE FROM chapter_download_queue
       WHERE chapter_id IN (
         SELECT id FROM chapter WHERE novel_id IN ($1, $2)
       )`,
      [sourceNovelId, targetNovelId],
    );
    await db.execute(
      `INSERT OR IGNORE INTO novel_category (novel_id, category_id)
       SELECT $2, category_id
       FROM novel_category
       WHERE novel_id = $1`,
      [sourceNovelId, targetNovelId],
    );
    let transferredDownloads = 0;
    const mergedReadAtByTargetId = new Map<number, number | null>();
    const chapterUpdates: NovelMergeChapterUpdate[] = [];
    for (const target of targetChapters) {
      const mappedSources = mappedSourcesByTargetId.get(target.id);
      if (!mappedSources || mappedSources.length === 0) {
        mergedReadAtByTargetId.set(target.id, target.readAt);
        continue;
      }
      const mergedState = mergeTargetState(target, mappedSources);
      const preparedSourceId = preparedSourceIdByTargetId.get(target.id);
      const preparedDownload = preparedSourceId === undefined
        ? null
        : preparedDownloadsBySourceId.get(preparedSourceId) ?? null;
      if (preparedDownload?.transferredFromSource) transferredDownloads += 1;
      chapterUpdates.push({
        applyDownloadMetadata: booleanParam(Boolean(preparedDownload)),
        bookmark: booleanParam(mergedState.bookmark),
        contentBytes: preparedDownload?.contentBytes ?? 0,
        contentType: preparedDownload?.contentType ?? null,
        id: target.id,
        mediaBytes: preparedDownload?.mediaBytes ?? 0,
        progress: mergedState.progress,
        readAt: mergedState.readAt,
        unread: booleanParam(mergedState.unread),
      });
      mergedReadAtByTargetId.set(target.id, mergedState.readAt);
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
      const params: unknown[] = [];
      const values = chunk.map((update) => {
        const row = [
          update.id,
          update.bookmark,
          update.unread,
          update.progress,
          update.readAt,
          update.applyDownloadMetadata,
          update.contentType,
          update.contentBytes,
          update.mediaBytes,
        ];
        return `(${row
          .map((value) => {
            params.push(value);
            return `$${params.length}`;
          })
          .join(", ")})`;
      });
      await db.execute(
        `WITH merge_updates (
           target_id,
           bookmark,
           unread,
           progress,
           read_at,
           apply_download_metadata,
           stored_content_type,
           content_bytes,
           media_bytes
         ) AS (VALUES ${values.join(", ")})
         UPDATE chapter
         SET
           bookmark = (SELECT bookmark FROM merge_updates WHERE target_id = chapter.id),
           unread = (SELECT unread FROM merge_updates WHERE target_id = chapter.id),
           progress = (SELECT progress FROM merge_updates WHERE target_id = chapter.id),
           read_at = (SELECT read_at FROM merge_updates WHERE target_id = chapter.id),
           stored_content_type = CASE
             WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1
             THEN (SELECT stored_content_type FROM merge_updates WHERE target_id = chapter.id)
             ELSE stored_content_type
           END,
           content_bytes = CASE
             WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1
             THEN (SELECT content_bytes FROM merge_updates WHERE target_id = chapter.id)
             ELSE content_bytes
           END,
           media_bytes = CASE
             WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1
             THEN (SELECT media_bytes FROM merge_updates WHERE target_id = chapter.id)
             ELSE media_bytes
           END,
           media_repair_needed = CASE
             WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1
             THEN 0
             ELSE media_repair_needed
           END,
           media_bytes_checked_at = CASE
             WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1
             THEN unixepoch()
             ELSE media_bytes_checked_at
           END,
           is_downloaded = CASE
             WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1
             THEN 1
             ELSE is_downloaded
           END,
           updated_at = unixepoch()
         WHERE id IN (SELECT target_id FROM merge_updates)`,
        params,
      );
    }

    const mergedLastReadAt = latestTimestamp([
      targetNovel.lastReadAt,
      ...mergedReadAtByTargetId.values(),
    ]);
    await db.execute(
      `UPDATE novel
       SET
         in_library = MAX(in_library, $2),
         library_added_at = CASE
           WHEN library_added_at IS NULL THEN $3
           WHEN $3 IS NULL THEN library_added_at
           ELSE MIN(library_added_at, $3)
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

    const preferredLastReadChapterId = [...mergedReadAtByTargetId.entries()]
      .filter((entry): entry is [number, number] => entry[1] != null)
      .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;

    const deleteResult = await db.execute(
      "DELETE FROM novel WHERE id = $1",
      [sourceNovelId],
    );
    if (deleteResult.rowsAffected !== 1) {
      throw new Error("Source novel changed before it could be deleted.");
    }

    return {
      targetNovelId,
      chapterIdMap,
      preferredLastReadChapterId,
      transferredDownloads,
    };
  });
}
