import type { TestSqliteDatabase as Database } from "./sql/types";
import {
  getChapterComposition,
  materializeChapterComposition,
  setChapterComposition,
} from "./sql/chapter-composition";
import type { DatabaseReadMode } from "../db/client";
import type { DbMutationEnvelope } from "../db/ipc";
import type {
  BulkChapterMutationResult,
  ChapterListRow,
  ChapterMutationResult,
  ChapterReadState,
  DownloadedChapterUpsertInput,
  InsertChapterInput,
  LatestSourceChapterAnchor,
  LibraryDownloadChapter,
  LibraryUpdateEntry,
  LibraryUpdatesCursor,
  LibraryUpdatesScope,
  RecentlyReadEntry,
  RelativeChapterDirection,
} from "../db/queries/chapter";
import type {
  HistoryCursor,
  HistoryPage,
  HistoryProgressFilter,
} from "../db/queries/history-search";
import { reconcileImportedNovelIdentityInDb } from "./sql/novel-identity";
import { sqliteBoolean } from "./sql/sqlite-value";
import { deferUserStateForNovelInDb } from "./sql/user-state-materialize";
import {
  hasUserStateSchema,
  markPrivateChapterProgressInDb,
  recordChaptersInDb,
  recordPublicNovelReadingInDb,
  recordResumeClearedInDb,
} from "./sql/user-state-core";
import { remapUnattemptedChapterPathsInDb } from "./sql/user-state-migration";
import { flushWorkMetadata, markWorkMetadataRefreshed } from "./sql/work-metadata";
import {
  parseChapterComposition,
  type ChapterSourceSnapshot,
} from "../lib/chapter-composition";
import {
  compositionSourceAnchor,
  refreshChapterComposition,
} from "../lib/chapter-composition-refresh";
import {
  normalizeChapterContentType,
  storedChapterContentType,
  type ChapterContentType,
} from "../lib/chapter-content";
import { LOCAL_NOVEL_PATH } from "../lib/local-library-identity";
import {
  MAX_ROUTE_QUERY_ROWS,
  clampRouteQueryLimit,
} from "../lib/performance-budgets";
import { LOCAL_PLUGIN_ID, type ChapterItem } from "../lib/plugins/types";
import {
  planSourceChapterNumberChanges,
  type SourceChapterRenumberJournal,
} from "../lib/source-chapter-renumber";
import {
  applySourceChapterNumberChangesInDb,
  commitSourceChapterRenumberInDb,
  createNovelMergeIpcHandler,
  readRenumberChaptersInDb,
} from "./mock-novel-merge-ipc";
import { createContentSyncIpcHandler } from "./mock-content-sync-ipc";

export interface ChapterIpcBridgeOptions {
  getDb: () => Database | Promise<Database>;
  getReadOnlyDb?: () =>
    | Pick<Database, "select">
    | Promise<Pick<Database, "select">>;
  runTransaction: (
    run: (db: Database) => Promise<any>,
    remoteContentSync?: boolean,
  ) => Promise<any>;
}

const FINISHED_PROGRESS = 100;
const SQLITE_BIND_PARAMETER_BUDGET = 900;
const SOURCE_CHAPTER_PARAM_COUNT = 8;
const SOURCE_CHAPTER_PATH_PARAM_COUNT = 4;
const DOWNLOADED_CHAPTER_PARAM_COUNT = 10;
const SOURCE_CHAPTER_CHUNK_SIZE = Math.max(
  1,
  Math.min(
    MAX_ROUTE_QUERY_ROWS,
    Math.floor(SQLITE_BIND_PARAMETER_BUDGET / SOURCE_CHAPTER_PARAM_COUNT),
  ),
);
const DOWNLOADED_CHAPTER_CHUNK_SIZE = Math.max(
  1,
  Math.min(
    MAX_ROUTE_QUERY_ROWS,
    Math.floor(SQLITE_BIND_PARAMETER_BUDGET / DOWNLOADED_CHAPTER_PARAM_COUNT),
  ),
);
const CHAPTER_ID_CHUNK_SIZE = Math.max(
  1,
  Math.min(MAX_ROUTE_QUERY_ROWS, SQLITE_BIND_PARAMETER_BUDGET - 2),
);

const CHAPTER_LIST_SELECT_FIELDS = `
  id,
  novel_id       AS novelId,
  path,
  name,
  chapter_number AS chapterNumber,
  position,
  page,
  bookmark,
  unread,
  progress,
  is_downloaded  AS isDownloaded,
  content_type   AS sourceContentType,
  stored_content_type AS storedContentType,
  content_bytes   AS contentBytes,
  media_bytes     AS mediaBytes,
  media_repair_needed AS mediaRepairNeeded,
  release_time   AS releaseTime,
  read_at        AS readAt,
  created_at     AS createdAt,
  found_at       AS foundAt,
  updated_at     AS updatedAt
`;

const RELEASE_OR_FOUND_AT_SQL = `MIN(COALESCE(CASE
    WHEN c.release_time GLOB '[0-9][0-9][0-9][0-9][-.][0-9][0-9][-.][0-9][0-9]'
      THEN unixepoch(replace(c.release_time, '.', '-'), 'utc')
    WHEN c.release_time GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]*'
      THEN unixepoch(c.release_time)
  END, c.found_at), c.found_at)`;

const KEEP_FINISHED_PROGRESS_SQL =
  "CASE WHEN progress >= 100 THEN progress ELSE $2 END";

type RawChapterListRow = Omit<
  ChapterListRow,
  | "bookmark"
  | "unread"
  | "isDownloaded"
  | "sourceContentType"
  | "contentType"
  | "mediaRepairNeeded"
> & {
  bookmark: unknown;
  unread: unknown;
  isDownloaded: unknown;
  sourceContentType: string | null;
  storedContentType: string | null;
  mediaRepairNeeded: unknown;
};

function chapterChunks<T>(items: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += chunkSize) {
    chunks.push(items.slice(start, start + chunkSize));
  }
  return chunks;
}

function chapterIdPlaceholders(startParam: number, count: number): string {
  return Array.from({ length: count }, (_, index) => `$${startParam + index}`).join(
    ", ",
  );
}

function normalizeChapterListRow(row: RawChapterListRow): ChapterListRow {
  const { storedContentType: rawStoredContentType, ...chapter } = row;
  const sourceContentType = normalizeChapterContentType(row.sourceContentType);
  const storedContentType = rawStoredContentType
    ? normalizeChapterContentType(rawStoredContentType)
    : null;
  return {
    ...chapter,
    bookmark: sqliteBoolean(row.bookmark),
    unread: sqliteBoolean(row.unread),
    isDownloaded: sqliteBoolean(row.isDownloaded),
    sourceContentType,
    contentType: storedContentType ?? sourceContentType,
    mediaRepairNeeded: sqliteBoolean(row.mediaRepairNeeded),
  };
}

async function withCompositionDisplay<
  T extends { novelId: number; path?: string; chapterPath?: string },
>(
  db: Pick<Database, "select">,
  rows: T[],
): Promise<
  Array<
    T & {
      displayChapterNumber?: string | null;
      compositionSource?: ChapterSourceSnapshot;
    }
  >
> {
  if (!rows.length) return rows;
  const novelIds = [...new Set(rows.map((row) => row.novelId))];
  const stored = await db.select<{ novelId: number; payload: string }[]>(
    "SELECT novel_id AS novelId,payload FROM novel_chapter_composition WHERE novel_id IN (" +
      novelIds.map((_, index) => "$" + (index + 1)).join(",") +
      ")",
    novelIds,
  );
  const displays = new Map<
    number,
    Map<
      string,
      { displayChapterNumber: string; compositionSource: ChapterSourceSnapshot }
    >
  >();
  for (const record of stored) {
    if (typeof record.payload !== "string") continue;
    const composition = parseChapterComposition(JSON.parse(record.payload));
    displays.set(
      record.novelId,
      new Map(
        composition.entries
          .filter((entry) => entry.user.included)
          .map((entry) => [
            entry.path,
            {
              displayChapterNumber:
                entry.user.chapterNumber ?? String(entry.user.order),
              compositionSource: entry.sources[entry.primarySource],
            },
          ]),
      ),
    );
  }
  return rows.map((row) => {
    const display = displays
      .get(row.novelId)
      ?.get(row.path ?? row.chapterPath ?? "");
    return display === undefined ? row : { ...row, ...display };
  });
}

async function getLatestSourceChapterAnchorInDb(
  db: Pick<Database, "select">,
  novelId: number,
): Promise<LatestSourceChapterAnchor | null> {
  const rows = await db.select<
    { chapterNumber: string | null; position: number; path: string }[]
  >(
    `SELECT chapter_number AS chapterNumber, position, path
     FROM chapter
     WHERE novel_id = $1`,
    [novelId],
  );
  if (rows.length === 0) return null;

  let latest: LatestSourceChapterAnchor | null = null;
  for (const row of rows) {
    if (row.path.startsWith("norea-folder:")) continue;
    if (row.chapterNumber === null) return null;
    const chapterNumber = Number(row.chapterNumber);
    if (!Number.isFinite(chapterNumber)) return null;
    if (!latest || chapterNumber > latest.chapterNumber) {
      latest = {
        novelId,
        chapterNumber,
        position: row.position,
      };
    }
  }
  return latest;
}

async function upsertSourceChaptersInDb(
  db: Database,
  inputs: readonly InsertChapterInput[],
): Promise<BulkChapterMutationResult> {
  if (inputs.length === 0) return { rowsAffected: 0, chunks: 0 };
  let rowsAffected = 0;
  let chunks = 0;
  for (const chunk of chapterChunks(inputs, SOURCE_CHAPTER_CHUNK_SIZE)) {
    const pathValuesSql = chunk
      .map((_, index) => {
        const param = index * SOURCE_CHAPTER_PATH_PARAM_COUNT + 1;
        return `($${param}, $${param + 1}, $${param + 2}, $${param + 3})`;
      })
      .join(", ");
    const pathParams = chunk.flatMap((input) => [
      input.novelId,
      input.path,
      input.chapterNumber ?? null,
      input.page ?? "1",
    ]);
    const before = (await hasUserStateSchema(db))
      ? await db.select<{ id: number; novelId: number; path: string }[]>(
          `WITH incoming(novel_id,path,chapter_number,page) AS (VALUES ${pathValuesSql})
           SELECT target.id,target.novel_id AS novelId,target.path FROM chapter target JOIN incoming
           ON incoming.novel_id=target.novel_id AND incoming.chapter_number IS target.chapter_number AND incoming.page IS target.page
           WHERE incoming.path IS NOT target.path`,
          pathParams,
        )
      : [];
    const migrateResult = await db.execute(
      `WITH incoming(novel_id, path, chapter_number, page) AS (
         VALUES ${pathValuesSql}
       )
       UPDATE chapter AS target
          SET path = (
            SELECT incoming.path
              FROM incoming
             WHERE incoming.novel_id IS target.novel_id
               AND incoming.chapter_number IS target.chapter_number
               AND incoming.page IS target.page
          ),
              updated_at = unixepoch()
        WHERE target.novel_id IN (SELECT novel_id FROM incoming)
          AND EXISTS (
            SELECT 1
              FROM incoming
             WHERE incoming.novel_id IS target.novel_id
               AND incoming.chapter_number IS target.chapter_number
               AND incoming.page IS target.page
               AND incoming.path IS NOT target.path
          )
          AND target.id = (
                SELECT MIN(existing.id)
                  FROM chapter AS existing
                 WHERE existing.novel_id IS target.novel_id
                   AND existing.chapter_number IS target.chapter_number
                   AND existing.page IS target.page
              )
          AND NOT EXISTS (
            SELECT 1
              FROM chapter AS existing
              JOIN incoming
                ON incoming.novel_id IS existing.novel_id
               AND incoming.path IS existing.path
             WHERE existing.id IS NOT target.id
               AND incoming.novel_id IS target.novel_id
               AND incoming.chapter_number IS target.chapter_number
               AND incoming.page IS target.page
          )`,
      pathParams,
    );
    await remapUnattemptedChapterPathsInDb(db, before);
    rowsAffected += migrateResult.rowsAffected;

    const valuesSql = chunk
      .map((_, index) => {
        const param = index * SOURCE_CHAPTER_PARAM_COUNT + 1;
        return `($${param}, $${param + 1}, $${param + 2}, $${param + 3}, $${param + 4}, $${param + 5}, $${param + 6}, $${param + 7}, unixepoch(), unixepoch())`;
      })
      .join(", ");
    const params = chunk.flatMap((input) => [
      input.novelId,
      input.path,
      input.name,
      input.position,
      input.chapterNumber ?? null,
      input.page ?? "1",
      input.releaseTime ?? null,
      normalizeChapterContentType(input.contentType),
    ]);
    const upsertResult = await db.execute(
      `INSERT INTO chapter
         (novel_id, path, name, position, chapter_number, page, release_time, content_type, created_at, found_at)
       VALUES ${valuesSql}
       ON CONFLICT(novel_id, path) DO UPDATE SET
         name           = excluded.name,
         position       = excluded.position,
         chapter_number = excluded.chapter_number,
         page           = excluded.page,
         release_time   = excluded.release_time,
         content_type   = excluded.content_type,
         updated_at     = unixepoch()
        WHERE
          name IS NOT excluded.name
          OR position IS NOT excluded.position
          OR chapter_number IS NOT excluded.chapter_number
          OR page IS NOT excluded.page
          OR release_time IS NOT excluded.release_time
          OR content_type IS NOT excluded.content_type`,
      params,
    );
    rowsAffected += upsertResult.rowsAffected;
    chunks += 1;
  }
  for (const novelId of new Set(inputs.map((row) => row.novelId))) {
    await deferUserStateForNovelInDb(db, novelId);
  }
  return { rowsAffected, chunks };
}

function metadataAssignment(
  column: string,
  preserveMissingMetadata: boolean,
): string {
  return preserveMissingMetadata
    ? `${column} = COALESCE(excluded.${column}, ${column})`
    : `${column} = excluded.${column}`;
}

function metadataChangedClause(
  column: string,
  preserveMissingMetadata: boolean,
): string {
  return preserveMissingMetadata
    ? `${column} IS NOT COALESCE(excluded.${column}, ${column})`
    : `${column} IS NOT excluded.${column}`;
}

function optionalText(value: string | undefined | null): string | null {
  return value?.trim() ? value : null;
}

export function createChapterIpcHandler(options: ChapterIpcBridgeOptions) {
  const novelMergeIpc = createNovelMergeIpcHandler(options);
  const contentSyncIpc = createContentSyncIpcHandler(options);
  const resolveReader = async (readMode?: unknown) => {
    if (readMode === "committed" && options.getReadOnlyDb) {
      return options.getReadOnlyDb();
    }
    return options.getDb();
  };

  return {
    async handle(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<{ handled: true; result: unknown } | { handled: false }> {
      if (command === "db_chapter_find_local_imported") {
        const db = await options.getDb();
        const [chapter] = await db.select<{ id: number; novelId: number }[]>(
          `SELECT c.id,c.novel_id AS novelId FROM chapter c JOIN novel n ON n.id=c.novel_id
           WHERE n.plugin_id=$1 AND n.path=$2 AND n.is_local=1 AND c.path=$3`,
          [LOCAL_PLUGIN_ID, LOCAL_NOVEL_PATH, `${String(args.pathKey)}/chapter-0001`],
        );
        return { handled: true, result: chapter ?? null };
      }

      if (command === "db_chapter_list_by_novel") {
        const db = await resolveReader(args.readMode);
        const rows = await db.select<RawChapterListRow[]>(
          `SELECT ${CHAPTER_LIST_SELECT_FIELDS}
           FROM chapter
           WHERE novel_id = $1
           ORDER BY position, id`,
          [args.novelId],
        );
        return {
          handled: true,
          result: await withCompositionDisplay(
            db,
            rows.map(normalizeChapterListRow),
          ),
        };
      }

      if (command === "db_chapter_list_library_download") {
        const db = await options.getDb();
        const rows = await db.select<
          Array<RawChapterListRow & { isDownloadQueued: unknown }>
        >(
          `SELECT ${CHAPTER_LIST_SELECT_FIELDS},
             EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id = chapter.id) AS isDownloadQueued
           FROM chapter
           WHERE novel_id = $1
           ORDER BY position, id`,
          [args.novelId],
        );
        const mapped: LibraryDownloadChapter[] = await withCompositionDisplay(
          db,
          rows.map((row) => ({
            ...normalizeChapterListRow(row),
            isDownloadQueued: sqliteBoolean(row.isDownloadQueued),
          })),
        );
        return { handled: true, result: mapped };
      }

      if (command === "db_chapter_list_unqueued_downloads") {
        const db = await options.getDb();
        const rows = await db.select<RawChapterListRow[]>(
          `SELECT ${CHAPTER_LIST_SELECT_FIELDS} FROM chapter
           WHERE novel_id = $1 AND id > $2
             AND EXISTS(SELECT 1 FROM novel n WHERE n.id = chapter.novel_id AND n.is_local = 0)
             AND is_downloaded = 0 AND content_bytes <= 0
             AND NOT EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id = chapter.id)
           ORDER BY id LIMIT $3`,
          [args.novelId, args.afterChapterId ?? 0, MAX_ROUTE_QUERY_ROWS],
        );
        return {
          handled: true,
          result: await withCompositionDisplay(
            db,
            rows.map(normalizeChapterListRow),
          ),
        };
      }

      if (command === "db_chapter_get_by_id") {
        const db = await resolveReader(args.readMode);
        const rows = await db.select<RawChapterListRow[]>(
          `SELECT ${CHAPTER_LIST_SELECT_FIELDS}
           FROM chapter
           WHERE id = $1`,
          [args.chapterId],
        );
        const row = rows[0]
          ? (
              await withCompositionDisplay(db, [normalizeChapterListRow(rows[0])])
            )[0]
          : null;
        return { handled: true, result: row ?? null };
      }

      if (command === "db_chapter_list_existing_ids") {
        const chapterIds = (args.chapterIds ?? []) as number[];
        if (chapterIds.length === 0) return { handled: true, result: [] };
        const db = await options.getDb();
        const existingChapterIds: number[] = [];
        for (const chunk of chapterChunks(
          [...new Set(chapterIds)],
          CHAPTER_ID_CHUNK_SIZE,
        )) {
          const rows = await db.select<{ id: number }[]>(
            `SELECT id FROM chapter WHERE id IN (${chapterIdPlaceholders(1, chunk.length)})`,
            chunk,
          );
          existingChapterIds.push(...rows.map((row) => row.id));
        }
        return { handled: true, result: existingChapterIds };
      }

      if (command === "db_chapter_get_latest_source_anchor") {
        const db = await options.getDb();
        return {
          handled: true,
          result: await getLatestSourceChapterAnchorInDb(
            db,
            args.novelId as number,
          ),
        };
      }

      if (command === "db_chapter_get_sync_since_anchor") {
        const db = await options.getDb();
        let existingNovelId = args.novelId as number | undefined;
        if (existingNovelId === undefined) {
          const [row] = await db.select<{ id: number }[]>(
            "SELECT id FROM novel WHERE plugin_id = $1 AND path = $2",
            [args.pluginId, args.path],
          );
          existingNovelId = row?.id;
        }
        if (!existingNovelId) {
          return { handled: true, result: null };
        }
        const composition = await getChapterComposition(db, existingNovelId);
        const [storedIdentity] = composition
          ? await db.select<{ sourceNovelId: string }[]>(
              "SELECT source_novel_id AS sourceNovelId FROM novel WHERE id=$1",
              [existingNovelId],
            )
          : [];
        const rawAnchor =
          composition && storedIdentity
            ? compositionSourceAnchor(composition, {
                pluginId: args.pluginId as string,
                novelId: storedIdentity.sourceNovelId,
              })
            : await getLatestSourceChapterAnchorInDb(db, existingNovelId);
        const anchor: LatestSourceChapterAnchor | null = rawAnchor
          ? {
              novelId: existingNovelId,
              chapterNumber: rawAnchor.chapterNumber,
              position: rawAnchor.position,
            }
          : null;
        return {
          handled: true,
          result: { existingNovelId, anchor },
        };
      }

      if (command === "db_chapter_get_adjacent") {
        const db = await options.getDb();
        const direction = args.direction as 1 | -1;
        const rows = await db.select<RawChapterListRow[]>(
          direction === 1
            ? `SELECT ${CHAPTER_LIST_SELECT_FIELDS}
               FROM chapter
               WHERE novel_id = $1 AND position > $2
               ORDER BY position ASC, id ASC
               LIMIT 1`
            : `SELECT ${CHAPTER_LIST_SELECT_FIELDS}
               FROM chapter
               WHERE novel_id = $1 AND position < $2
               ORDER BY position DESC, id DESC
               LIMIT 1`,
          [args.novelId, args.position],
        );
        const row = rows[0]
          ? (
              await withCompositionDisplay(db, [normalizeChapterListRow(rows[0])])
            )[0]
          : null;
        return { handled: true, result: row ?? null };
      }

      if (command === "db_chapter_upsert_source") {
        const inputs = (args.inputs ?? []) as InsertChapterInput[];
        const remoteContentSync = Boolean(args.remoteContentSync);
        const value = await options.runTransaction(
          (db) => upsertSourceChaptersInDb(db, inputs),
          remoteContentSync,
        );
        return {
          handled: true,
          result: { value, effects: {} } satisfies DbMutationEnvelope<BulkChapterMutationResult>,
        };
      }

      if (command === "db_chapter_upsert_downloaded") {
        const inputs = (args.inputs ?? []) as Array<
          DownloadedChapterUpsertInput & { contentBytes: number }
        >;
        const value = await options.runTransaction(async (db) => {
          let rowsAffected = 0;
          let chunks = 0;
          for (const chunk of chapterChunks(
            inputs,
            DOWNLOADED_CHAPTER_CHUNK_SIZE,
          )) {
            const valuesSql = chunk
              .map((_, index) => {
                const param = index * DOWNLOADED_CHAPTER_PARAM_COUNT + 1;
                return `($${param}, $${param + 1}, $${param + 2}, $${param + 3}, $${param + 4}, $${param + 5}, $${param + 6}, $${param + 7}, $${param + 8}, $${param + 9}, 0, 1, unixepoch(), unixepoch())`;
              })
              .join(", ");
            const params = chunk.flatMap((input) => {
              const sourceType = normalizeChapterContentType(input.contentType);
              return [
                input.novelId,
                input.path,
                input.name,
                input.position,
                input.chapterNumber ?? null,
                input.page ?? "1",
                input.releaseTime ?? null,
                sourceType,
                storedChapterContentType(sourceType),
                input.contentBytes,
              ];
            });
            const result = await db.execute(
              `INSERT INTO chapter
                 (novel_id, path, name, position, chapter_number, page, release_time, content_type, stored_content_type, content_bytes, media_repair_needed, is_downloaded, created_at, found_at)
               VALUES ${valuesSql}
               ON CONFLICT(novel_id, path) DO UPDATE SET
                 name           = excluded.name,
                 position       = excluded.position,
                 chapter_number = excluded.chapter_number,
                 page           = excluded.page,
                 release_time   = excluded.release_time,
                 content_type   = excluded.content_type,
                 stored_content_type = excluded.stored_content_type,
                 content_bytes  = excluded.content_bytes,
                 media_repair_needed = 0,
                 media_bytes_checked_at = NULL,
                 is_downloaded  = 1,
                 updated_at     = unixepoch()
                WHERE
                  name IS NOT excluded.name
                  OR position IS NOT excluded.position
                  OR chapter_number IS NOT excluded.chapter_number
                  OR page IS NOT excluded.page
                  OR release_time IS NOT excluded.release_time
                  OR content_type IS NOT excluded.content_type
                  OR stored_content_type IS NOT excluded.stored_content_type
                  OR content_bytes IS NOT excluded.content_bytes
                  OR media_repair_needed IS NOT 0
                  OR is_downloaded IS NOT 1`,
              params,
            );
            rowsAffected += result.rowsAffected;
            chunks += 1;
          }
          return { rowsAffected, chunks };
        });
        return {
          handled: true,
          result: { value, effects: {} } satisfies DbMutationEnvelope<BulkChapterMutationResult>,
        };
      }

      if (command === "db_chapter_insert_if_absent") {
        const db = await options.getDb();
        const input = args.input as InsertChapterInput;
        await db.execute(
          `INSERT OR IGNORE INTO chapter
             (novel_id, path, name, position, chapter_number, page, release_time, content_type, created_at, found_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, unixepoch(), unixepoch())`,
          [
            input.novelId,
            input.path,
            input.name,
            input.position,
            input.chapterNumber ?? null,
            input.page ?? "1",
            input.releaseTime ?? null,
            normalizeChapterContentType(input.contentType),
          ],
        );
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_chapter_upsert") {
        const db = await options.getDb();
        const input = args.input as InsertChapterInput;
        const result = await db.execute(
          `INSERT INTO chapter
             (novel_id, path, name, position, chapter_number, page, release_time, content_type, created_at, found_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, unixepoch(), unixepoch())
           ON CONFLICT(novel_id, path) DO UPDATE SET
             name           = excluded.name,
             position       = excluded.position,
             chapter_number = excluded.chapter_number,
             page           = excluded.page,
             release_time   = excluded.release_time,
             content_type   = excluded.content_type,
             updated_at     = unixepoch()
            WHERE
              name IS NOT excluded.name
              OR position IS NOT excluded.position
              OR chapter_number IS NOT excluded.chapter_number
              OR page IS NOT excluded.page
              OR release_time IS NOT excluded.release_time
              OR content_type IS NOT excluded.content_type`,
          [
            input.novelId,
            input.path,
            input.name,
            input.position,
            input.chapterNumber ?? null,
            input.page ?? "1",
            input.releaseTime ?? null,
            normalizeChapterContentType(input.contentType),
          ],
        );
        return {
          handled: true,
          result: {
            value: { rowsAffected: result.rowsAffected },
            effects: {},
          } satisfies DbMutationEnvelope<ChapterMutationResult>,
        };
      }

      if (command === "db_chapter_update_progress") {
        const input = args.input as {
          chapterId: number;
          progress: number;
          recordHistory?: boolean;
        };
        const clamped = Math.max(0, Math.min(100, Math.round(input.progress)));
        const recordHistory = input.recordHistory ?? true;
        await options.runTransaction(async (db) => {
          if (recordHistory) {
            await db.execute(
              `UPDATE chapter
               SET
                 progress   = ${KEEP_FINISHED_PROGRESS_SQL},
                 unread     = CASE WHEN $2 >= 100 THEN 0 ELSE unread END,
                 read_at    = CASE WHEN $2 > 0 THEN unixepoch() ELSE read_at END,
                 updated_at = unixepoch()
               WHERE id = $1`,
              [input.chapterId, clamped],
            );
            await db.execute(
              `UPDATE novel
               SET last_read_at = unixepoch(), updated_at = unixepoch()
               WHERE id = (
                 SELECT novel_id FROM chapter WHERE id = $1
               )`,
              [input.chapterId],
            );
            await recordChaptersInDb(db, [input.chapterId]);
            return;
          }
          await markPrivateChapterProgressInDb(db, input.chapterId);
          await db.execute(
            `UPDATE chapter
             SET
               progress   = ${KEEP_FINISHED_PROGRESS_SQL},
               unread     = CASE WHEN $2 >= 100 THEN 0 ELSE unread END,
               updated_at = unixepoch()
             WHERE id = $1`,
            [input.chapterId, clamped],
          );
        });
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_chapter_set_read_state") {
        const input = args.input as { chapterIds: number[]; unread: boolean };
        const unreadFlag = input.unread ? 1 : 0;
        const progress = input.unread ? 0 : FINISHED_PROGRESS;
        const value = await options.runTransaction(async (db) => {
          let rowsAffected = 0;
          let chunks = 0;
          const previous: ChapterReadState[] = [];
          for (const chunk of chapterChunks(
            input.chapterIds,
            CHAPTER_ID_CHUNK_SIZE,
          )) {
            const rows = await db.select<
              Array<{ id: number; progress: number; unread: unknown }>
            >(
              `SELECT id, unread, progress FROM chapter WHERE id IN (${chapterIdPlaceholders(1, chunk.length)})`,
              chunk,
            );
            previous.push(
              ...rows.map((row) => ({
                id: row.id,
                progress: row.progress,
                unread: sqliteBoolean(row.unread),
              })),
            );
            const result = await db.execute(
              `UPDATE chapter
               SET
                 progress   = $1,
                 unread     = $2,
                 updated_at = unixepoch()
               WHERE id IN (${chapterIdPlaceholders(3, chunk.length)})
                 AND (progress <> $1 OR unread <> $2)`,
              [progress, unreadFlag, ...chunk],
            );
            rowsAffected += result.rowsAffected;
            chunks += 1;
          }
          await recordChaptersInDb(db, input.chapterIds);
          return { rowsAffected, chunks, previous };
        });
        return {
          handled: true,
          result: { value, effects: {} } satisfies DbMutationEnvelope<
            BulkChapterMutationResult & { previous: ChapterReadState[] }
          >,
        };
      }

      if (command === "db_chapter_set_novels_read_state") {
        const input = args.input as { novelIds: number[]; unread: boolean };
        const unreadFlag = input.unread ? 1 : 0;
        const progress = input.unread ? 0 : FINISHED_PROGRESS;
        const value = await options.runTransaction(async (db) => {
          let rowsAffected = 0;
          let chunks = 0;
          const previous: ChapterReadState[] = [];
          for (const chunk of chapterChunks(
            input.novelIds,
            CHAPTER_ID_CHUNK_SIZE,
          )) {
            const rows = await db.select<
              Array<{ id: number; progress: number; unread: unknown }>
            >(
              `SELECT id, unread, progress FROM chapter
               WHERE novel_id IN (${chapterIdPlaceholders(3, chunk.length)})
                 AND (progress <> $1 OR unread <> $2)`,
              [progress, unreadFlag, ...chunk],
            );
            previous.push(
              ...rows.map((row) => ({
                id: row.id,
                progress: row.progress,
                unread: sqliteBoolean(row.unread),
              })),
            );
            const result = await db.execute(
              `UPDATE chapter
               SET
                 progress   = $1,
                 unread     = $2,
                 updated_at = unixepoch()
               WHERE novel_id IN (${chapterIdPlaceholders(3, chunk.length)})
                 AND (progress <> $1 OR unread <> $2)`,
              [progress, unreadFlag, ...chunk],
            );
            rowsAffected += result.rowsAffected;
            chunks += 1;
          }
          if (await hasUserStateSchema(db)) {
            const rows = await db.select<{ id: number }[]>(
              `SELECT id FROM chapter WHERE novel_id IN (${chapterIdPlaceholders(1, input.novelIds.length)})`,
              input.novelIds,
            );
            await recordChaptersInDb(
              db,
              rows.map((row) => row.id),
            );
          }
          return { rowsAffected, chunks, previous };
        });
        return {
          handled: true,
          result: { value, effects: {} } satisfies DbMutationEnvelope<
            BulkChapterMutationResult & { previous: ChapterReadState[] }
          >,
        };
      }

      if (command === "db_chapter_restore_read_states") {
        const states = (args.states ?? []) as ChapterReadState[];
        const groups = new Map<
          string,
          { ids: number[]; progress: number; unread: number }
        >();
        for (const state of states) {
          const unread = state.unread ? 1 : 0;
          const key = `${unread}:${state.progress}`;
          const group = groups.get(key) ?? {
            ids: [],
            progress: state.progress,
            unread,
          };
          group.ids.push(state.id);
          groups.set(key, group);
        }
        const value = await options.runTransaction(async (db) => {
          let rowsAffected = 0;
          let chunks = 0;
          for (const group of groups.values()) {
            for (const chunk of chapterChunks(
              group.ids,
              CHAPTER_ID_CHUNK_SIZE,
            )) {
              const result = await db.execute(
                `UPDATE chapter
                 SET
                   progress   = $1,
                   unread     = $2,
                   updated_at = unixepoch()
                 WHERE id IN (${chapterIdPlaceholders(3, chunk.length)})`,
                [group.progress, group.unread, ...chunk],
              );
              rowsAffected += result.rowsAffected;
              chunks += 1;
            }
          }
          await recordChaptersInDb(
            db,
            states.map((state) => state.id),
          );
          return { rowsAffected, chunks };
        });
        return {
          handled: true,
          result: { value, effects: {} } satisfies DbMutationEnvelope<BulkChapterMutationResult>,
        };
      }

      if (command === "db_chapter_set_relative_read_state") {
        const input = args.input as {
          anchorChapterId: number;
          direction: RelativeChapterDirection;
          unread: boolean;
        };
        const rangePredicate =
          input.direction === "before"
            ? `(candidate.position < reference.position
                OR (candidate.position = reference.position
                    AND candidate.id < reference.id))`
            : `(candidate.position > reference.position
                OR (candidate.position = reference.position
                    AND candidate.id > reference.id))`;
        const progress = input.unread ? 0 : FINISHED_PROGRESS;
        const unreadFlag = input.unread ? 1 : 0;
        const value = await options.runTransaction(async (db) => {
          const previous = await db.select<
            Array<{ id: number; progress: number; unread: unknown }>
          >(
            `WITH reference AS (
               SELECT id, novel_id, position
               FROM chapter
               WHERE id = $1
             )
             SELECT candidate.id, candidate.unread, candidate.progress
             FROM chapter AS candidate
             CROSS JOIN reference
             WHERE candidate.novel_id = reference.novel_id
               AND candidate.id <> reference.id
               AND ${rangePredicate}
               AND (candidate.progress <> $2 OR candidate.unread <> $3)`,
            [input.anchorChapterId, progress, unreadFlag],
          );
          const result = await db.execute(
            `WITH reference AS (
               SELECT id, novel_id, position
               FROM chapter
               WHERE id = $1
             )
             UPDATE chapter
             SET
               progress   = $2,
               unread     = $3,
               updated_at = unixepoch()
             WHERE id IN (
               SELECT candidate.id
               FROM chapter AS candidate
               CROSS JOIN reference
               WHERE candidate.novel_id = reference.novel_id
                 AND candidate.id <> reference.id
                 AND ${rangePredicate}
             )
               AND (progress <> $2 OR unread <> $3)`,
            [input.anchorChapterId, progress, unreadFlag],
          );
          if (await hasUserStateSchema(db)) {
            const targets = await db.select<{ id: number }[]>(
              `WITH reference AS (SELECT id,novel_id,position FROM chapter WHERE id=$1)
               SELECT candidate.id FROM chapter candidate CROSS JOIN reference WHERE candidate.novel_id=reference.novel_id
               AND candidate.id<>reference.id AND ${rangePredicate}`,
              [input.anchorChapterId],
            );
            await recordChaptersInDb(
              db,
              targets.map((row) => row.id),
            );
          }
          return {
            rowsAffected: result.rowsAffected,
            previous: previous.map((row) => ({
              id: row.id,
              progress: row.progress,
              unread: sqliteBoolean(row.unread),
            })),
          };
        });
        return {
          handled: true,
          result: { value, effects: {} } satisfies DbMutationEnvelope<
            ChapterMutationResult & { previous: ChapterReadState[] }
          >,
        };
      }

      if (command === "db_chapter_mark_opened") {
        const chapterId = args.chapterId as number;
        await options.runTransaction(async (db) => {
          await db.execute(
            `UPDATE chapter
             SET read_at = unixepoch(), updated_at = unixepoch()
             WHERE id = $1`,
            [chapterId],
          );
          await db.execute(
            `UPDATE novel
             SET last_read_at = unixepoch(), updated_at = unixepoch()
             WHERE id = (
               SELECT novel_id FROM chapter WHERE id = $1
             )`,
            [chapterId],
          );
          await recordChaptersInDb(db, [chapterId]);
        });
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_chapter_clear_novel_history") {
        const novelId = args.novelId as number;
        await options.runTransaction(async (db) => {
          await db.execute(
            `UPDATE chapter
             SET read_at = NULL, updated_at = unixepoch()
             WHERE novel_id = $1 AND read_at IS NOT NULL`,
            [novelId],
          );
          await db.execute(
            `UPDATE novel
             SET last_read_at = NULL, updated_at = unixepoch()
             WHERE id = $1`,
            [novelId],
          );
          await recordPublicNovelReadingInDb(db, [novelId], true);
          await recordResumeClearedInDb(db, [novelId]);
        });
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_chapter_set_bookmark") {
        const chapterId = args.chapterId as number;
        const bookmarked = Boolean(args.bookmarked);
        await options.runTransaction(async (db) => {
          await db.execute(
            `UPDATE chapter
             SET bookmark = $2, updated_at = unixepoch()
             WHERE id = $1`,
            [chapterId, bookmarked ? 1 : 0],
          );
          await recordChaptersInDb(db, [chapterId], "bookmark");
        });
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_chapter_save_content_metadata") {
        const db = await options.getDb();
        const input = args.input as {
          chapterId: number;
          contentBytes: number;
          contentType: ChapterContentType;
          mediaBytes?: number;
          mediaRepairNeeded: boolean;
        };
        const normalizedContentType = storedChapterContentType(
          normalizeChapterContentType(input.contentType),
        );
        const result = await db.execute(
          `UPDATE chapter
           SET
             stored_content_type = $2,
             content_bytes  = $3,
             media_bytes    = $4,
             media_repair_needed = $5,
             media_bytes_checked_at = CASE WHEN $6 = 1 THEN unixepoch() ELSE NULL END,
             is_downloaded  = 1,
             updated_at     = unixepoch()
           WHERE id = $1`,
          [
            input.chapterId,
            normalizedContentType,
            input.contentBytes,
            input.mediaBytes ?? 0,
            input.mediaRepairNeeded ? 1 : 0,
            input.mediaBytes === undefined ? 0 : 1,
          ],
        );
        return {
          handled: true,
          result: {
            value: { rowsAffected: result.rowsAffected },
            effects: {},
          } satisfies DbMutationEnvelope<ChapterMutationResult>,
        };
      }

      if (command === "db_chapter_save_partial_content_metadata") {
        const db = await options.getDb();
        const input = args.input as {
          chapterId: number;
          contentBytes: number;
          contentType: ChapterContentType;
          mediaRepairNeeded: boolean;
        };
        const normalizedContentType = storedChapterContentType(
          normalizeChapterContentType(input.contentType),
        );
        const result = await db.execute(
          `UPDATE chapter
           SET
             stored_content_type = $2,
             content_bytes  = $3,
             media_repair_needed = MAX(media_repair_needed, $4),
             media_bytes_checked_at = NULL,
             updated_at     = unixepoch()
           WHERE id = $1`,
          [
            input.chapterId,
            normalizedContentType,
            input.contentBytes,
            input.mediaRepairNeeded ? 1 : 0,
          ],
        );
        return {
          handled: true,
          result: {
            value: { rowsAffected: result.rowsAffected },
            effects: {},
          } satisfies DbMutationEnvelope<ChapterMutationResult>,
        };
      }

      if (command === "db_chapter_mark_media_repair_pending") {
        const db = await options.getDb();
        const result = await db.execute(
          `UPDATE chapter SET media_repair_needed = 1, is_downloaded = 0,
            media_bytes_checked_at = NULL WHERE id = $1`,
          [args.chapterId],
        );
        return {
          handled: true,
          result: {
            value: { rowsAffected: result.rowsAffected },
            effects: {},
          } satisfies DbMutationEnvelope<ChapterMutationResult>,
        };
      }

      if (command === "db_chapter_adopt_stored_content_metadata") {
        const db = await options.getDb();
        const input = args.input as {
          chapterId: number;
          contentBytes: number;
          mediaBytes: number;
          contentType: ChapterContentType | null;
          mediaRepairNeeded: boolean;
        };
        const normalizedContentType = input.contentType
          ? storedChapterContentType(
              normalizeChapterContentType(input.contentType),
            )
          : null;
        const result = await db.execute(
          `UPDATE chapter
           SET
             content_bytes  = $2,
             media_bytes    = $3,
             media_repair_needed = $5,
             media_bytes_checked_at = unixepoch(),
             stored_content_type = COALESCE($4, stored_content_type),
             is_downloaded  = 1 - $5
           WHERE id = $1
             AND (content_bytes IS NOT $2
               OR media_bytes IS NOT $3
               OR media_repair_needed IS NOT $5
               OR ($4 IS NOT NULL AND stored_content_type IS NOT $4)
               OR is_downloaded IS NOT (1 - $5))`,
          [
            input.chapterId,
            input.contentBytes,
            input.mediaBytes,
            normalizedContentType,
            input.mediaRepairNeeded ? 1 : 0,
          ],
        );
        let rowsAffected = result.rowsAffected;
        if (rowsAffected === 0) {
          const checked = await db.execute(
            "UPDATE chapter SET media_bytes_checked_at = unixepoch() WHERE id = $1",
            [input.chapterId],
          );
          rowsAffected = checked.rowsAffected;
        }
        return {
          handled: true,
          result: {
            value: { rowsAffected },
            effects: {},
          } satisfies DbMutationEnvelope<ChapterMutationResult>,
        };
      }

      if (command === "db_chapter_mark_stored_content_missing") {
        const db = await options.getDb();
        const result = await db.execute(
          `UPDATE chapter
           SET
             content_bytes  = 0,
             media_bytes    = 0,
             media_repair_needed = 0,
             media_bytes_checked_at = NULL,
             stored_content_type = NULL,
             is_downloaded  = 0
           WHERE id = $1
             AND novel_id IN (
               SELECT id
               FROM novel
               WHERE is_local = 0
             )`,
          [args.chapterId],
        );
        return {
          handled: true,
          result: {
            value: { rowsAffected: result.rowsAffected },
            effects: {},
          } satisfies DbMutationEnvelope<ChapterMutationResult>,
        };
      }

      if (command === "db_chapter_clear_content") {
        const db = await options.getDb();
        await db.execute(
          `UPDATE chapter
           SET
             content_bytes  = 0,
             media_bytes    = 0,
             media_repair_needed = 0,
             media_bytes_checked_at = NULL,
             stored_content_type = NULL,
             is_downloaded  = 0,
             updated_at     = unixepoch()
           WHERE id = $1
             AND novel_id IN (
               SELECT id
               FROM novel
               WHERE is_local = 0
             )`,
          [args.chapterId],
        );
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_chapter_list_library_updates") {
        const db = await resolveReader(args.readMode);
        const input = (args.input ?? {}) as {
          limit?: number;
          cursor?: LibraryUpdatesCursor | null;
          scope?: LibraryUpdatesScope;
        };
        const normalizedLimit = clampRouteQueryLimit(input.limit ?? 100, 100);
        const scope = input.scope ?? "new";
        const cursor = input.cursor ?? null;
        const sortAt = scope === "new" ? RELEASE_OR_FOUND_AT_SQL : "c.found_at";
        const cursorClause = cursor
          ? `AND (
               ${sortAt} < $1
               OR (${sortAt} = $1 AND c.position < $2)
               OR (${sortAt} = $1 AND c.position = $2 AND c.id < $3)
             )`
          : "";
        const params = cursor
          ? [cursor.sortAt, cursor.position, cursor.chapterId, normalizedLimit]
          : [normalizedLimit];
        const limitParam = cursor ? "$4" : "$1";
        const rows = await db.select<
          Array<
            Omit<
              LibraryUpdateEntry,
              "contentType" | "isDownloaded" | "novelIsLocal"
            > & {
              contentType: string;
              isDownloaded: number;
              novelIsLocal: unknown;
            }
          >
        >(
          `SELECT
             c.id              AS chapterId,
             c.path            AS chapterPath,
             c.novel_id        AS novelId,
             n.plugin_id       AS pluginId,
             ip.name           AS pluginName,
             n.source_novel_id AS novelSourceNovelId,
             n.path            AS novelPath,
             c.name            AS chapterName,
             COALESCE(c.stored_content_type, c.content_type) AS contentType,
             c.position,
             ${sortAt} AS sortAt,
             c.is_downloaded   AS isDownloaded,
             n.name            AS novelName,
             n.cover           AS novelCover,
             n.is_local        AS novelIsLocal
           FROM chapter c
           JOIN novel n ON n.id = c.novel_id
           LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id
           WHERE
             n.in_library = 1
             AND c.unread = 1
             ${scope === "new" ? "AND c.found_by_check = 1" : ""}
             ${cursorClause}
           ORDER BY sortAt DESC, c.position DESC, c.id DESC
           LIMIT ${limitParam}`,
          params,
        );
        return {
          handled: true,
          result: rows.map((row) => ({
            ...row,
            contentType: normalizeChapterContentType(row.contentType),
            isDownloaded: Boolean(row.isDownloaded),
            novelIsLocal: sqliteBoolean(row.novelIsLocal),
          })),
        };
      }

      if (command === "db_chapter_count_new_since") {
        const db = await resolveReader(args.readMode);
        const [row] = await db.select<{ count: number }[]>(
          `SELECT COUNT(*) AS count FROM chapter c JOIN novel n ON n.id = c.novel_id
           WHERE n.in_library = 1 AND c.unread = 1 AND c.found_by_check = 1 AND c.found_at > $1`,
          [args.seenAt],
        );
        return { handled: true, result: row?.count ?? 0 };
      }

      if (command === "db_chapter_list_reading_history_page") {
        const db = await resolveReader(args.readMode as DatabaseReadMode);
        const input = (args.input ?? {}) as {
          cursor?: HistoryCursor | null;
          limit?: number;
          progress?: HistoryProgressFilter;
          search?: string;
        };
        const pageSize = clampRouteQueryLimit(input.limit ?? 50, 50);
        const progress = input.progress ?? "all";
        const term = (input.search ?? "").trim();
        const cursor = input.cursor ?? null;
        const params: unknown[] = [pageSize + 1];
        const param = (value: unknown) => `$${params.push(value)}`;
        let searchClause = "";
        if (term) {
          const termParam = param(term);
          searchClause = `AND (
               instr(lower(novelName), lower(${termParam})) > 0
               OR instr(lower(chapterName), lower(${termParam})) > 0
               OR instr(CAST(position AS TEXT), ${termParam}) > 0
               OR instr(COALESCE(chapterNumber, ''), ${termParam}) > 0
             )`;
        }
        let cursorClause = "";
        if (cursor) {
          const readAt = param(cursor.readAt);
          const position = param(cursor.position);
          const chapterId = param(cursor.chapterId);
          cursorClause = `AND (
               readAt < ${readAt}
               OR (readAt = ${readAt} AND position < ${position})
               OR (readAt = ${readAt} AND position = ${position} AND chapterId < ${chapterId})
             )`;
        }
        const progressClause =
          progress === "finished"
            ? `AND progress >= ${FINISHED_PROGRESS}`
            : progress === "inProgress"
              ? `AND progress < ${FINISHED_PROGRESS}`
              : "";
        const rows = await db.select<
          Array<
            Omit<RecentlyReadEntry, "novelInLibrary" | "novelIsLocal"> & {
              novelInLibrary: unknown;
              novelIsLocal: unknown;
            }
          >
        >(
          `WITH latest AS (
             SELECT
               c.id          AS chapterId,
               c.novel_id    AS novelId,
               c.name        AS chapterName,
               c.chapter_number AS chapterNumber,
               c.path        AS chapterPath,
               c.position    AS position,
               c.read_at     AS readAt,
               c.progress    AS progress,
               n.plugin_id   AS pluginId,
               n.source_novel_id AS novelSourceNovelId,
               n.name        AS novelName,
               n.cover       AS novelCover,
               n.in_library  AS novelInLibrary,
               n.is_local    AS novelIsLocal,
               n.path        AS novelPath
             FROM novel n
             JOIN chapter c ON c.id = (
               SELECT c2.id
               FROM chapter c2
               WHERE c2.novel_id = n.id AND c2.read_at IS NOT NULL
               ORDER BY c2.read_at DESC, c2.position DESC, c2.id DESC
               LIMIT 1
             )
           )
           SELECT * FROM latest
           WHERE 1 = 1
             ${searchClause}
             ${progressClause}
             ${cursorClause}
           ORDER BY readAt DESC, position DESC, chapterId DESC
           LIMIT $1`,
          params,
        );
        const normalized = await withCompositionDisplay(
          db,
          rows.slice(0, pageSize).map((row) => ({
            ...row,
            novelInLibrary: sqliteBoolean(row.novelInLibrary),
            novelIsLocal: sqliteBoolean(row.novelIsLocal),
          })),
        );
        const last = normalized.at(-1);
        const page: HistoryPage = {
          entries: normalized,
          nextCursor:
            rows.length > pageSize && last
              ? {
                  chapterId: last.chapterId,
                  position: last.position,
                  readAt: last.readAt,
                }
              : null,
        };
        return { handled: true, result: page };
      }

      if (command === "db_novel_sync_from_source") {
        const input = args.input as {
          pluginId: string;
          novelPath: string;
          itemName: string;
          novelName: string;
          sourceNovelId: string;
          cover: string | null;
          summary: string | null;
          author: string | null;
          artist: string | null;
          status: string | null;
          genres: string | null;
          rating: number | null;
          preserveMissingMetadata: boolean;
          markFoundByCheck: boolean;
          startPosition: number;
          expectedNovelId?: number;
          chapters: Array<{
            path: string;
            name: string;
            chapterNumber: number;
            sourceChapterId?: string;
            page: string;
            releaseTime: string | null;
            contentType: ChapterContentType;
          }>;
          renumber: SourceChapterRenumberJournal | null;
        };
        const chapterInputs: InsertChapterInput[] = input.chapters.map(
          (chapter, index) => ({
            novelId: 0,
            path: chapter.path,
            name: chapter.name,
            position: input.startPosition + index,
            chapterNumber: String(chapter.chapterNumber),
            page: chapter.page ?? "1",
            releaseTime: chapter.releaseTime ?? null,
            contentType: chapter.contentType,
          }),
        );
        const detailChapters: ChapterItem[] = input.chapters.map((chapter) => ({
          path: chapter.path,
          name: chapter.name,
          chapterNumber: chapter.chapterNumber,
          ...(chapter.sourceChapterId !== undefined
            ? { sourceChapterId: chapter.sourceChapterId }
            : {}),
          page: chapter.page,
          releaseTime: chapter.releaseTime ?? undefined,
          contentType: chapter.contentType,
        }));
        const value = await options.runTransaction(async (db) => {
          if (input.expectedNovelId !== undefined) {
            const [current] = await db.select<{ id: number }[]>(
              "SELECT id FROM novel WHERE id=$1 AND plugin_id=$2 AND path=$3",
              [input.expectedNovelId, input.pluginId, input.novelPath],
            );
            if (!current) {
              throw new Error(
                "Work no longer matches the source refresh; open it again before refreshing.",
              );
            }
          }
          const reconciled = await reconcileImportedNovelIdentityInDb(
            db,
            {
              pluginId: input.pluginId,
              path: input.novelPath,
              name: input.itemName,
            },
            chapterInputs,
          );
          const [storedIdentity] = await db.select<
            Array<{
              sourceNovelId: string | null;
              previousCover?: string | null;
              coverFetchedAt?: number | null;
            }>
          >(
            `SELECT n.source_novel_id AS sourceNovelId, n.cover AS previousCover, f.cover_fetched_at AS coverFetchedAt
             FROM novel n LEFT JOIN novel_freshness f ON f.novel_id = n.id WHERE n.plugin_id=$1 AND n.path=$2`,
            [input.pluginId, input.novelPath],
          );
          if (
            storedIdentity?.sourceNovelId &&
            storedIdentity.sourceNovelId !== input.sourceNovelId
          ) {
            throw new Error(
              `Plugin '${input.pluginId}' changed a stored novel ID.`,
            );
          }
          const novelResult = await db.execute(
            `INSERT INTO novel (plugin_id, path, name, cover, summary, author, artist, status, genres, rating, source_novel_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT(plugin_id, path) DO UPDATE SET
               name = excluded.name,
               source_novel_id = excluded.source_novel_id,
               ${metadataAssignment("cover", input.preserveMissingMetadata)},
               ${metadataAssignment("summary", input.preserveMissingMetadata)},
               ${metadataAssignment("author", input.preserveMissingMetadata)},
               ${metadataAssignment("artist", input.preserveMissingMetadata)},
               ${metadataAssignment("status", input.preserveMissingMetadata)},
               ${metadataAssignment("genres", input.preserveMissingMetadata)},
               ${metadataAssignment("rating", input.preserveMissingMetadata)},
               updated_at = unixepoch()
              WHERE
                source_novel_id IS NOT excluded.source_novel_id
                OR name IS NOT excluded.name
                OR ${metadataChangedClause("cover", input.preserveMissingMetadata)}
                OR ${metadataChangedClause("summary", input.preserveMissingMetadata)}
                OR ${metadataChangedClause("author", input.preserveMissingMetadata)}
                OR ${metadataChangedClause("artist", input.preserveMissingMetadata)}
                OR ${metadataChangedClause("status", input.preserveMissingMetadata)}
                OR ${metadataChangedClause("genres", input.preserveMissingMetadata)}
                OR ${metadataChangedClause("rating", input.preserveMissingMetadata)}`,
            [
              input.pluginId,
              input.novelPath,
              input.novelName,
              input.cover,
              input.summary,
              input.author,
              input.artist,
              input.status,
              input.genres,
              input.rating,
              input.sourceNovelId,
            ],
          );
          const rows = await db.select<
            Array<{ cover: string | null; id: number; inLibrary: unknown }>
          >(
            `SELECT id, cover, in_library AS inLibrary
             FROM novel
             WHERE plugin_id = $1 AND path = $2`,
            [input.pluginId, input.novelPath],
          );
          const novelRow = rows[0];
          if (!novelRow?.id) {
            throw new Error("sync-novel: failed to resolve local novel id");
          }
          const novelId = novelRow.id;
          const [before] = input.markFoundByCheck
            ? await db.select<{ chapters: number; maxId: number }[]>(
                `SELECT (SELECT COUNT(*) FROM chapter WHERE novel_id = $1) AS chapters,
                        (SELECT COALESCE(MAX(id), 0) FROM chapter) AS maxId`,
                [novelId],
              )
            : [];
          const composition = await getChapterComposition(db, novelId);
          let chapterMutation: { rowsAffected: number };
          if (composition) {
            if (input.renumber) {
              throw new Error(
                "A composed chapter list cannot be renumbered by a provider refresh.",
              );
            }
            const updated = refreshChapterComposition(
              composition,
              {
                pluginId: input.pluginId,
                novelId: input.sourceNovelId,
                novelPath: input.novelPath,
              },
              detailChapters,
              { startPosition: input.startPosition },
            );
            const changedEntries = updated.entries.filter(
              (entry, index) =>
                JSON.stringify(entry) !==
                JSON.stringify(composition.entries[index]),
            ).length;
            await materializeChapterComposition(db, novelId, updated);
            await setChapterComposition(db, novelId, updated);
            chapterMutation = { rowsAffected: changedEntries };
          } else {
            if (input.renumber) {
              await applySourceChapterNumberChangesInDb(
                db,
                novelId,
                input.renumber,
              );
            } else if (
              planSourceChapterNumberChanges(
                {
                  id: novelId,
                  pluginId: input.pluginId,
                  sourceNovelId: input.sourceNovelId,
                  path: input.novelPath,
                },
                await readRenumberChaptersInDb(db, novelId),
                detailChapters,
              ).length
            ) {
              throw new Error(
                "Chapter numbers changed during refresh. Refresh the complete chapter list again.",
              );
            }
            chapterMutation = await upsertSourceChaptersInDb(
              db,
              chapterInputs.map((chapter) => ({
                ...chapter,
                novelId,
              })),
            );
          }
          const newChapters =
            before && before.chapters > 0
              ? (
                  await db.execute(
                    "UPDATE chapter SET found_by_check = 1 WHERE novel_id = $1 AND id > $2",
                    [novelId, before.maxId],
                  )
                ).rowsAffected
              : 0;
          if (composition) {
            await flushWorkMetadata(db);
          } else {
            await flushWorkMetadata(db, {
              novelId,
              chapters: Object.fromEntries(
                input.chapters.map((chapter) => [
                  String(chapter.chapterNumber),
                  chapter.name,
                ]),
              ),
              ...(input.renumber
                ? {
                    replacedChapterNumbers: input.renumber.changes.map(
                      (change) => change.chapterNumber,
                    ),
                  }
                : {}),
            });
          }
          const stored =
            novelResult.rowsAffected > 0 ||
            (reconciled?.changed ?? false) ||
            chapterMutation.rowsAffected > 0;
          const republish = stored || !input.markFoundByCheck;
          if (republish) {
            await markWorkMetadataRefreshed(db, {
              pluginId: input.pluginId,
              novelPath: input.novelPath,
            });
          }
          if (input.renumber) {
            await commitSourceChapterRenumberInDb(db, input.renumber);
          }
          await deferUserStateForNovelInDb(db, novelId);
          return {
            republish,
            changedChapters: chapterMutation.rowsAffected,
            newChapters,
            cover: input.preserveMissingMetadata
              ? optionalText(novelRow.cover) ?? input.cover
              : input.cover,
            coverChanged:
              optionalText(storedIdentity?.previousCover) !== null &&
              optionalText(storedIdentity?.previousCover) !==
                optionalText(novelRow.cover),
            coverFetchedAt: storedIdentity?.coverFetchedAt ?? null,
            novelChanged:
              novelResult.rowsAffected > 0 || (reconciled?.changed ?? false),
            inLibrary: sqliteBoolean(novelRow.inLibrary),
            novelId,
          };
        });
        return {
          handled: true,
          result: { value, effects: {} },
        };
      }

      const mergeHandled = await novelMergeIpc.handle(command, args);
      if (mergeHandled.handled) return mergeHandled;
      return contentSyncIpc.handle(command, args);
    },
  };
}
