import { getDb, runDatabaseTransaction } from "../client";
import { UNCATEGORIZED_CATEGORY_ID } from "./category";
import { upsertDownloadedChaptersInDb } from "./chapter";
import {
  normalizeChapterContentType,
  storedChapterContentType,
  type ChapterContentType,
} from "../../lib/chapter-content";
import type { EpubHtmlResource } from "../../lib/epub-html";
import type { LocalImportBinaryResource } from "../../lib/local-import";
import { isLocalCoverSource } from "../../lib/local-cover";
import {
  clampRouteQueryLimit,
  MAX_ROUTE_QUERY_ROWS,
} from "../../lib/performance-budgets";
import type { LibrarySortOrder } from "../../store/library";

export const LOCAL_PLUGIN_ID = "local";

/**
 * Shape returned by the Library list query.
 *
 * SQL aliases the snake_case columns into camelCase so consumers
 * can treat rows as plain TS records without a separate mapping
 * layer.
 */
export interface LibraryNovel {
  id: number;
  pluginId: string;
  pluginName?: string | null;
  path: string;
  name: string;
  cover: string | null;
  author: string | null;
  inLibrary: boolean;
  isLocal: boolean;
  totalChapters: number;
  chaptersDownloaded: number;
  chaptersUnread: number;
  readingProgress: number;
  lastReadAt: number | null;
  lastUpdatedAt: number;
}

export interface LibraryFilter {
  /** Case-insensitive substring match against `name`. Empty and blank values are ignored. */
  search?: string;
  /** Restrict to an assigned category, or to uncategorized novels with the sentinel id. */
  categoryId?: number | null;
  downloadedOnly?: boolean;
  unreadOnly?: boolean;
  sortOrder?: LibrarySortOrder;
  /** Optional route-level guard for screens that render bounded library windows. */
  limit?: number;
}

export interface LibraryNovelCursor {
  id: number;
  name: string;
  sortValue: number | string;
}

export interface LibraryNovelPage {
  hasMore: boolean;
  nextCursor: LibraryNovelCursor | null;
  novels: LibraryNovel[];
}

export interface LibraryNovelSummary {
  completeNovels: number;
  downloadedChapters: number;
  downloadedNovels: number;
  lastUpdatedAt: number | null;
  localNovels: number;
  totalChapters: number;
  totalNovels: number;
  unreadChapters: number;
  unreadNovels: number;
}

interface LibraryNovelPageFilter extends LibraryFilter {
  cursor?: LibraryNovelCursor | null;
}

interface RawLibraryNovel extends Omit<LibraryNovel, "inLibrary" | "isLocal"> {
  inLibrary: unknown;
  isLocal: unknown;
}

type LibrarySortCursorKind = "name" | "unique" | "valueName";

interface LibrarySortConfig {
  cursorColumn: string;
  cursorKind: LibrarySortCursorKind;
  direction: "asc" | "desc";
  getSortValue: (novel: LibraryNovel) => number | string;
  orderBy: string;
  valueKind: "number" | "text";
}

interface RawLibraryNovelSummary {
  completeNovels: number | null;
  downloadedChapters: number | null;
  downloadedNovels: number | null;
  lastUpdatedAt: number | null;
  localNovels: number | null;
  totalChapters: number | null;
  totalNovels: number | null;
  unreadChapters: number | null;
  unreadNovels: number | null;
}

export interface LibraryNovelRefreshTarget {
  id: number;
  pluginId: string;
  path: string;
  name: string;
  cover: string | null;
  isLocal: boolean;
}

interface RawLibraryNovelRefreshTarget
  extends Omit<LibraryNovelRefreshTarget, "isLocal"> {
  isLocal: unknown;
}

const DEFAULT_LIBRARY_PAGE_LIMIT = Math.min(100, MAX_ROUTE_QUERY_ROWS);

const LIBRARY_SORT_CONFIG: Record<LibrarySortOrder, LibrarySortConfig> = {
  nameAsc: {
    cursorColumn: "name",
    cursorKind: "name",
    direction: "asc",
    getSortValue: (novel) => novel.name,
    orderBy: "name COLLATE NOCASE ASC, id ASC",
    valueKind: "text",
  },
  nameDesc: {
    cursorColumn: "name",
    cursorKind: "name",
    direction: "desc",
    getSortValue: (novel) => novel.name,
    orderBy: "name COLLATE NOCASE DESC, id ASC",
    valueKind: "text",
  },
  downloadedAsc: {
    cursorColumn: "chaptersDownloaded",
    cursorKind: "valueName",
    direction: "asc",
    getSortValue: (novel) => novel.chaptersDownloaded,
    orderBy: "chaptersDownloaded ASC, name COLLATE NOCASE ASC, id ASC",
    valueKind: "number",
  },
  downloadedDesc: {
    cursorColumn: "chaptersDownloaded",
    cursorKind: "valueName",
    direction: "desc",
    getSortValue: (novel) => novel.chaptersDownloaded,
    orderBy: "chaptersDownloaded DESC, name COLLATE NOCASE ASC, id ASC",
    valueKind: "number",
  },
  totalChaptersAsc: {
    cursorColumn: "totalChapters",
    cursorKind: "valueName",
    direction: "asc",
    getSortValue: (novel) => novel.totalChapters,
    orderBy: "totalChapters ASC, name COLLATE NOCASE ASC, id ASC",
    valueKind: "number",
  },
  totalChaptersDesc: {
    cursorColumn: "totalChapters",
    cursorKind: "valueName",
    direction: "desc",
    getSortValue: (novel) => novel.totalChapters,
    orderBy: "totalChapters DESC, name COLLATE NOCASE ASC, id ASC",
    valueKind: "number",
  },
  unreadChaptersAsc: {
    cursorColumn: "chaptersUnread",
    cursorKind: "valueName",
    direction: "asc",
    getSortValue: (novel) => novel.chaptersUnread,
    orderBy: "chaptersUnread ASC, name COLLATE NOCASE ASC, id ASC",
    valueKind: "number",
  },
  unreadChaptersDesc: {
    cursorColumn: "chaptersUnread",
    cursorKind: "valueName",
    direction: "desc",
    getSortValue: (novel) => novel.chaptersUnread,
    orderBy: "chaptersUnread DESC, name COLLATE NOCASE ASC, id ASC",
    valueKind: "number",
  },
  dateAddedAsc: {
    cursorColumn: "id",
    cursorKind: "unique",
    direction: "asc",
    getSortValue: (novel) => novel.id,
    orderBy: "id ASC",
    valueKind: "number",
  },
  dateAddedDesc: {
    cursorColumn: "id",
    cursorKind: "unique",
    direction: "desc",
    getSortValue: (novel) => novel.id,
    orderBy: "id DESC",
    valueKind: "number",
  },
  lastReadAsc: {
    cursorColumn: "lastReadSort",
    cursorKind: "valueName",
    direction: "asc",
    getSortValue: (novel) => novel.lastReadAt ?? 0,
    orderBy: "lastReadSort ASC, name COLLATE NOCASE ASC, id ASC",
    valueKind: "number",
  },
  lastReadDesc: {
    cursorColumn: "lastReadSort",
    cursorKind: "valueName",
    direction: "desc",
    getSortValue: (novel) => novel.lastReadAt ?? 0,
    orderBy: "lastReadSort DESC, name COLLATE NOCASE ASC, id ASC",
    valueKind: "number",
  },
  lastUpdatedAsc: {
    cursorColumn: "lastUpdatedAt",
    cursorKind: "valueName",
    direction: "asc",
    getSortValue: (novel) => novel.lastUpdatedAt,
    orderBy: "lastUpdatedAt ASC, name COLLATE NOCASE ASC, id ASC",
    valueKind: "number",
  },
  lastUpdatedDesc: {
    cursorColumn: "lastUpdatedAt",
    cursorKind: "valueName",
    direction: "desc",
    getSortValue: (novel) => novel.lastUpdatedAt,
    orderBy: "lastUpdatedAt DESC, name COLLATE NOCASE ASC, id ASC",
    valueKind: "number",
  },
};

function addParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function buildLibraryFilterConditions(
  filter: LibraryFilter,
  params: unknown[],
): string[] {
  const conditions: string[] = ["n.in_library = 1"];

  const trimmedSearch = filter.search?.trim() ?? "";
  if (trimmedSearch !== "") {
    const searchParam = addParam(params, trimmedSearch);
    conditions.push(
      `n.name LIKE '%' || ${searchParam} || '%' COLLATE NOCASE`,
    );
  }
  if (filter.categoryId === UNCATEGORIZED_CATEGORY_ID) {
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id)",
    );
  } else if (filter.categoryId != null) {
    const categoryParam = addParam(params, filter.categoryId);
    conditions.push(
      `EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id AND nc.category_id = ${categoryParam})`,
    );
  }
  if (filter.downloadedOnly) {
    conditions.push(
      "(n.is_local = 1 OR COALESCE(s.chapters_downloaded, 0) > 0)",
    );
  }
  if (filter.unreadOnly) {
    conditions.push("COALESCE(s.chapters_unread, 0) > 0");
  }

  return conditions;
}

function libraryRowsCte(conditions: readonly string[]): string {
  return `
    WITH library_rows AS (
      SELECT
      n.id,
      n.plugin_id    AS pluginId,
      ip.name        AS pluginName,
      n.path,
      n.name,
      n.cover,
      n.author,
      n.in_library   AS inLibrary,
      n.is_local     AS isLocal,
      COALESCE(s.total_chapters, 0) AS totalChapters,
      COALESCE(s.chapters_downloaded, 0) AS chaptersDownloaded,
      COALESCE(s.chapters_unread, 0) AS chaptersUnread,
      COALESCE(s.reading_progress, 0) AS readingProgress,
      n.last_read_at AS lastReadAt,
      COALESCE(n.last_read_at, 0) AS lastReadSort,
      CASE
        WHEN COALESCE(s.total_chapters, 0) > 0
          THEN COALESCE(s.last_chapter_updated_at, n.updated_at)
        ELSE n.updated_at
      END AS lastUpdatedAt
    FROM novel n
    LEFT JOIN novel_stats s ON s.novel_id = n.id
    LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id
    WHERE ${conditions.join(" AND ")}
    )
  `;
}

function normalizeCursorSortValue(
  cursor: LibraryNovelCursor,
  config: LibrarySortConfig,
): number | string {
  if (config.valueKind === "text") return String(cursor.sortValue);
  return typeof cursor.sortValue === "number"
    ? cursor.sortValue
    : Number(cursor.sortValue) || 0;
}

function buildLibraryCursorClause(
  filter: LibraryNovelPageFilter,
  params: unknown[],
  config: LibrarySortConfig,
): string {
  if (!filter.cursor) return "";

  const op = config.direction === "asc" ? ">" : "<";
  const valueParam = addParam(
    params,
    normalizeCursorSortValue(filter.cursor, config),
  );

  if (config.cursorKind === "unique") {
    return `WHERE ${config.cursorColumn} ${op} ${valueParam}`;
  }

  const idParam = addParam(params, filter.cursor.id);
  if (config.cursorKind === "name") {
    return `WHERE (
      ${config.cursorColumn} COLLATE NOCASE ${op} ${valueParam} COLLATE NOCASE
      OR (
        ${config.cursorColumn} COLLATE NOCASE = ${valueParam} COLLATE NOCASE
        AND id > ${idParam}
      )
    )`;
  }

  const nameParam = addParam(params, filter.cursor.name);
  return `WHERE (
    ${config.cursorColumn} ${op} ${valueParam}
    OR (
      ${config.cursorColumn} = ${valueParam}
      AND name COLLATE NOCASE > ${nameParam} COLLATE NOCASE
    )
    OR (
      ${config.cursorColumn} = ${valueParam}
      AND name COLLATE NOCASE = ${nameParam} COLLATE NOCASE
      AND id > ${idParam}
    )
  )`;
}

async function selectLibraryNovels(
  filter: LibraryNovelPageFilter,
): Promise<LibraryNovel[]> {
  const db = await getDb();
  const params: unknown[] = [];
  const conditions = buildLibraryFilterConditions(filter, params);
  const sortConfig = LIBRARY_SORT_CONFIG[filter.sortOrder ?? "dateAddedDesc"];
  const cursorClause = buildLibraryCursorClause(filter, params, sortConfig);
  const limitClause =
    filter.limit === undefined
      ? ""
      : `LIMIT ${addParam(params, clampRouteQueryLimit(filter.limit))}`;
  const sql = `
    ${libraryRowsCte(conditions)}
    SELECT
      id,
      pluginId,
      pluginName,
      path,
      name,
      cover,
      author,
      inLibrary,
      isLocal,
      totalChapters,
      chaptersDownloaded,
      chaptersUnread,
      readingProgress,
      lastReadAt,
      lastUpdatedAt
    FROM library_rows
    ${cursorClause}
    ORDER BY ${sortConfig.orderBy}
    ${limitClause}
  `;

  const rows = await db.select<RawLibraryNovel[]>(sql, params);
  return rows.map((row) => {
    const isLocal = isLocalNovel(row.pluginId, row.isLocal);
    return {
      ...row,
      cover: isLocal ? displayLocalCover(row.cover) : row.cover,
      inLibrary: sqliteBoolean(row.inLibrary),
      isLocal,
    };
  });
}

export async function listLibraryNovels(
  filter: LibraryFilter = {},
): Promise<LibraryNovel[]> {
  return selectLibraryNovels(filter);
}

function getLibraryNovelCursor(
  novel: LibraryNovel | undefined,
  sortOrder: LibrarySortOrder,
): LibraryNovelCursor | null {
  if (!novel) return null;
  return {
    id: novel.id,
    name: novel.name,
    sortValue: LIBRARY_SORT_CONFIG[sortOrder].getSortValue(novel),
  };
}

export async function listLibraryNovelPage(
  filter: LibraryNovelPageFilter = {},
): Promise<LibraryNovelPage> {
  const sortOrder = filter.sortOrder ?? "dateAddedDesc";
  const normalizedLimit = clampRouteQueryLimit(
    filter.limit ?? DEFAULT_LIBRARY_PAGE_LIMIT,
    DEFAULT_LIBRARY_PAGE_LIMIT,
  );
  const rows = await selectLibraryNovels({
    ...filter,
    limit: normalizedLimit + 1,
  });
  const novels = rows.slice(0, normalizedLimit);
  const hasMore = rows.length > normalizedLimit;
  return {
    hasMore,
    nextCursor: hasMore ? getLibraryNovelCursor(novels.at(-1), sortOrder) : null,
    novels,
  };
}

export async function getLibraryNovelSummary(
  filter: LibraryFilter = {},
): Promise<LibraryNovelSummary> {
  const db = await getDb();
  const params: unknown[] = [];
  const conditions = buildLibraryFilterConditions(filter, params);
  const rows = await db.select<RawLibraryNovelSummary[]>(
    `${libraryRowsCte(conditions)}
     SELECT
       COUNT(*) AS totalNovels,
       COALESCE(SUM(totalChapters), 0) AS totalChapters,
       COALESCE(SUM(chaptersDownloaded), 0) AS downloadedChapters,
       COALESCE(SUM(chaptersUnread), 0) AS unreadChapters,
       MAX(lastUpdatedAt) AS lastUpdatedAt,
       COALESCE(SUM(CASE WHEN chaptersUnread > 0 THEN 1 ELSE 0 END), 0) AS unreadNovels,
       COALESCE(SUM(CASE WHEN chaptersDownloaded > 0 THEN 1 ELSE 0 END), 0) AS downloadedNovels,
       COALESCE(SUM(CASE WHEN pluginId = '${LOCAL_PLUGIN_ID}' AND isLocal = 1 THEN 1 ELSE 0 END), 0) AS localNovels,
       COALESCE(SUM(CASE WHEN totalChapters > 0 AND chaptersUnread = 0 THEN 1 ELSE 0 END), 0) AS completeNovels
     FROM library_rows`,
    params,
  );
  const row = rows[0];
  return {
    completeNovels: row?.completeNovels ?? 0,
    downloadedChapters: row?.downloadedChapters ?? 0,
    downloadedNovels: row?.downloadedNovels ?? 0,
    lastUpdatedAt: row?.lastUpdatedAt ?? null,
    localNovels: row?.localNovels ?? 0,
    totalChapters: row?.totalChapters ?? 0,
    totalNovels: row?.totalNovels ?? 0,
    unreadChapters: row?.unreadChapters ?? 0,
    unreadNovels: row?.unreadNovels ?? 0,
  };
}

export async function listLibraryNovelRefreshTargets(
  filter: Pick<LibraryFilter, "categoryId"> = {},
): Promise<LibraryNovelRefreshTarget[]> {
  const db = await getDb();
  const conditions: string[] = ["n.in_library = 1"];
  const params: unknown[] = [];

  if (filter.categoryId === UNCATEGORIZED_CATEGORY_ID) {
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id)",
    );
  } else if (filter.categoryId != null) {
    params.push(filter.categoryId);
    conditions.push(
      `EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id AND nc.category_id = $${params.length})`,
    );
  }

  const rows = await db.select<RawLibraryNovelRefreshTarget[]>(
    `SELECT
       n.id,
       n.plugin_id AS pluginId,
       n.path,
       n.name,
       n.cover,
       n.is_local AS isLocal
     FROM novel n
     WHERE ${conditions.join(" AND ")}
     ORDER BY n.name COLLATE NOCASE ASC`,
    params,
  );

  return rows.map((row) => ({
    ...row,
    isLocal: isLocalNovel(row.pluginId, row.isLocal),
  }));
}

/**
 * Full row shape used by the novel detail screen. Booleans are
 * coerced from SQLite's 0/1 ints so consumers can use strict
 * `=== true` comparisons.
 */
export interface NovelDetailRecord {
  id: number;
  pluginId: string;
  pluginName?: string | null;
  path: string;
  name: string;
  cover: string | null;
  summary: string | null;
  author: string | null;
  artist: string | null;
  status: string | null;
  genres: string | null;
  inLibrary: boolean;
  isLocal: boolean;
  createdAt: number;
  updatedAt: number;
  libraryAddedAt: number | null;
  lastReadAt: number | null;
}

interface RawNovelDetail extends Omit<NovelDetailRecord, "inLibrary" | "isLocal"> {
  inLibrary: unknown;
  isLocal: unknown;
}

const SELECT_NOVEL_DETAIL_FIELDS = `
  SELECT
    n.id,
    n.plugin_id      AS pluginId,
    ip.name          AS pluginName,
    n.path,
    n.name,
    n.cover,
    n.summary,
    n.author,
    n.artist,
    n.status,
    n.genres,
    n.in_library     AS inLibrary,
    n.is_local       AS isLocal,
    n.created_at     AS createdAt,
    n.updated_at     AS updatedAt,
    n.library_added_at AS libraryAddedAt,
    n.last_read_at   AS lastReadAt
  FROM novel n
  LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id
`;

function mapNovelDetail(row: RawNovelDetail): NovelDetailRecord {
  const isLocal = isLocalNovel(row.pluginId, row.isLocal);
  return {
    ...row,
    cover: isLocal ? displayLocalCover(row.cover) : row.cover,
    inLibrary: sqliteBoolean(row.inLibrary),
    isLocal,
  };
}

export async function getNovelById(
  id: number,
): Promise<NovelDetailRecord | null> {
  const db = await getDb();
  const rows = await db.select<RawNovelDetail[]>(
    `${SELECT_NOVEL_DETAIL_FIELDS}
     WHERE n.id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? mapNovelDetail(row) : null;
}

export async function findNovelBySource(
  pluginId: string,
  path: string,
): Promise<NovelDetailRecord | null> {
  const db = await getDb();
  const rows = await db.select<RawNovelDetail[]>(
    `${SELECT_NOVEL_DETAIL_FIELDS}
     WHERE n.plugin_id = $1
       AND n.path = $2`,
    [pluginId, path],
  );
  const row = rows[0];
  return row ? mapNovelDetail(row) : null;
}

export async function findLocalNovelByPath(
  path: string,
): Promise<NovelDetailRecord | null> {
  const db = await getDb();
  const rows = await db.select<RawNovelDetail[]>(
    `${SELECT_NOVEL_DETAIL_FIELDS}
     WHERE n.plugin_id = $1
       AND n.path = $2
       AND n.is_local = 1`,
    [LOCAL_PLUGIN_ID, path],
  );
  const row = rows[0];
  return row ? mapNovelDetail(row) : null;
}

/**
 * Toggle a novel's library membership. Touches `updated_at` so
 * Library reorders the row on the next paint.
 */
export async function setNovelInLibrary(
  id: number,
  inLibrary: boolean,
): Promise<void> {
  const db = await getDb();
  const inLibraryFlag = inLibrary ? 1 : 0;
  await db.execute(
    `UPDATE novel
     SET
       in_library = $2,
       library_added_at = CASE WHEN $2 = 1 THEN unixepoch() ELSE NULL END,
       updated_at = unixepoch()
     WHERE id = $1`,
    [id, inLibraryFlag],
  );
  if (inLibrary) {
    await db.execute(
      `UPDATE chapter
       SET found_at = MAX(COALESCE(found_at, 0), unixepoch())
       WHERE novel_id = $1`,
      [id],
    );
  }
}

export async function countNovels(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) AS count FROM novel",
  );
  return rows[0]?.count ?? 0;
}

export interface InsertNovelInput {
  pluginId: string;
  path: string;
  name: string;
  cover?: string | null;
  inLibrary?: boolean;
}

export async function insertNovelIfAbsent(
  input: InsertNovelInput,
): Promise<void> {
  const db = await getDb();
  const inLibrary = (input.inLibrary ?? true) ? 1 : 0;
  await db.execute(
    `INSERT OR IGNORE INTO novel
       (plugin_id, path, name, cover, in_library, library_added_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 1 THEN unixepoch() ELSE NULL END)`,
    [
      input.pluginId,
      input.path,
      input.name,
      input.cover ?? null,
      inLibrary,
    ],
  );
}

export interface LocalNovelImportChapterInput {
  binaryResource?: LocalImportBinaryResource;
  path: string;
  name: string;
  position: number;
  content: string;
  contentType?: ChapterContentType;
  contentBytes: number;
  chapterNumber?: string | null;
  mediaResources?: EpubHtmlResource[];
  page?: string;
  releaseTime?: string | null;
}

export interface LocalNovelImportInput {
  path: string;
  name: string;
  cover?: string | null;
  summary?: string | null;
  author?: string | null;
  artist?: string | null;
  status?: string | null;
  genres?: string | null;
  chapters: LocalNovelImportChapterInput[];
}

export interface LocalNovelImportResult {
  changed: boolean;
  changedChapters: number;
  novelId: number;
  chapterCount: number;
}

export interface LocalChapterOrderMutationResult {
  rowsAffected: number;
}

function localImportPathKeyFromChapterPath(path: string): string | null {
  const marker = "/chapter-";
  const markerIndex = path.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const pathKey = path.slice(0, markerIndex);
  if (!pathKey.startsWith("local:")) return null;
  const chapterSuffix = path.slice(markerIndex + marker.length);
  return /^\d{4}$/.test(chapterSuffix) ? pathKey : null;
}

async function deleteStaleLocalImportChapters(
  db: Awaited<ReturnType<typeof getDb>>,
  novelId: number,
  chapters: LocalNovelImportChapterInput[],
): Promise<number> {
  const pathKeys = [
    ...new Set(
      chapters
        .map((chapter) => localImportPathKeyFromChapterPath(chapter.path))
        .filter((pathKey): pathKey is string => pathKey !== null),
    ),
  ];
  if (pathKeys.length === 0) return 0;

  const keepPaths = [...new Set(chapters.map((chapter) => chapter.path))];
  const keepSql = keepPaths
    .map((_, index) => `$${index + 3}`)
    .join(", ");
  let deletedChapters = 0;

  for (const pathKey of pathKeys) {
    const result = await db.execute(
      `DELETE FROM chapter
       WHERE novel_id = $1
         AND path LIKE $2
         AND path NOT IN (${keepSql})`,
      [novelId, `${pathKey}/chapter-%`, ...keepPaths],
    );
    deletedChapters += result.rowsAffected;
  }

  return deletedChapters;
}

async function ensureLocalNovelExists(
  db: Awaited<ReturnType<typeof getDb>>,
  novelId: number,
): Promise<void> {
  const novelRows = await db.select<{ id: number }[]>(
    `SELECT id FROM novel WHERE id = $1 AND plugin_id = $2 AND is_local = 1`,
    [novelId, LOCAL_PLUGIN_ID],
  );
  if (!novelRows[0]) {
    throw new Error("local novel: target novel is not local");
  }
}

async function renumberLocalNovelChaptersWithDb(
  db: Awaited<ReturnType<typeof getDb>>,
  novelId: number,
): Promise<LocalChapterOrderMutationResult> {
  const rows = await db.select<
    { chapterNumber: string | null; id: number; position: number }[]
  >(
    `SELECT id, position, chapter_number AS chapterNumber
     FROM chapter
     WHERE novel_id = $1
     ORDER BY position, id`,
    [novelId],
  );
  const changedEntries = rows
    .map((row, index) => ({
      chapterId: row.id,
      chapterNumber: String(index + 1),
      position: index + 1,
      previousChapterNumber: row.chapterNumber,
      previousPosition: row.position,
    }))
    .filter(
      (entry) =>
        entry.previousPosition !== entry.position ||
        entry.previousChapterNumber !== entry.chapterNumber,
    );
  if (changedEntries.length === 0) return { rowsAffected: 0 };

  const requestedValuesSql = changedEntries
    .map((_, index) => {
      const idParam = index * 3 + 1;
      const positionParam = idParam + 1;
      const chapterNumberParam = idParam + 2;
      return `($${idParam}, $${positionParam}, $${chapterNumberParam})`;
    })
    .join(", ");
  const novelIdParam = changedEntries.length * 3 + 1;
  const params = changedEntries.flatMap(
    ({ chapterId, position, chapterNumber }) => [
      chapterId,
      position,
      chapterNumber,
    ],
  );
  const result = await db.execute(
    `WITH requested(id, position, chapter_number) AS (VALUES ${requestedValuesSql})
     UPDATE chapter
     SET
       position = (
         SELECT requested.position
         FROM requested
         WHERE requested.id = chapter.id
       ),
       chapter_number = (
         SELECT requested.chapter_number
         FROM requested
         WHERE requested.id = chapter.id
       ),
       updated_at = unixepoch()
     WHERE novel_id = $${novelIdParam}
       AND id IN (SELECT id FROM requested)
       AND (
         position IS NOT (
           SELECT requested.position
           FROM requested
           WHERE requested.id = chapter.id
         )
         OR chapter_number IS NOT (
           SELECT requested.chapter_number
           FROM requested
           WHERE requested.id = chapter.id
         )
       )`,
    [...params, novelId],
  );
  if (result.rowsAffected !== changedEntries.length) {
    throw new Error("local novel: failed to renumber chapter order");
  }
  return { rowsAffected: result.rowsAffected };
}

export async function renumberLocalNovelChapters(
  novelId: number,
): Promise<LocalChapterOrderMutationResult> {
  const db = await getDb();
  await ensureLocalNovelExists(db, novelId);
  return renumberLocalNovelChaptersWithDb(db, novelId);
}

export interface LocalNovelMetadataInput {
  name: string;
  cover?: string | null;
  summary?: string | null;
  author?: string | null;
  artist?: string | null;
  status?: string | null;
  genres?: string | null;
}

function nullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function nullableLocalCover(value: string | null | undefined): string | null {
  const trimmed = nullableText(value);
  if (!trimmed) return null;
  if (isLocalCoverSource(trimmed)) return trimmed;
  return null;
}

function displayLocalCover(value: string | null): string | null {
  return isLocalCoverSource(value) ? value : null;
}

function sqliteBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  }
  return false;
}

function isLocalNovel(pluginId: string, value: unknown): boolean {
  return pluginId === LOCAL_PLUGIN_ID && sqliteBoolean(value);
}

export async function upsertLocalNovelMetadata(
  input: LocalNovelMetadataInput & { path: string },
): Promise<number> {
  const db = await getDb();
  const name = input.name.trim();
  if (!name) throw new Error("local novel: name is required");

  await db.execute(
    `INSERT INTO novel
       (plugin_id, path, name, cover, summary, author, artist, status, genres, in_library, is_local, library_added_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1, unixepoch())
     ON CONFLICT(plugin_id, path) DO UPDATE SET
       name             = excluded.name,
       cover            = excluded.cover,
       summary          = excluded.summary,
       author           = excluded.author,
       artist           = excluded.artist,
       status           = excluded.status,
       genres           = excluded.genres,
       in_library       = 1,
       is_local         = 1,
       library_added_at = COALESCE(library_added_at, unixepoch()),
       updated_at       = unixepoch()`,
    [
      LOCAL_PLUGIN_ID,
      input.path,
      name,
      nullableLocalCover(input.cover),
      nullableText(input.summary),
      nullableText(input.author),
      nullableText(input.artist),
      nullableText(input.status),
      nullableText(input.genres),
    ],
  );

  const rows = await db.select<{ id: number }[]>(
    `SELECT id FROM novel WHERE plugin_id = $1 AND path = $2 AND is_local = 1`,
    [LOCAL_PLUGIN_ID, input.path],
  );
  const novelId = rows[0]?.id;
  if (!novelId) {
    throw new Error("local novel: failed to resolve local novel id");
  }
  return novelId;
}

export async function updateLocalNovelMetadata(
  novelId: number,
  input: LocalNovelMetadataInput,
): Promise<void> {
  const db = await getDb();
  const name = input.name.trim();
  if (!name) throw new Error("local novel: name is required");

  const novelRows = await db.select<{ id: number }[]>(
    `SELECT id FROM novel WHERE id = $1 AND plugin_id = $2 AND is_local = 1`,
    [novelId, LOCAL_PLUGIN_ID],
  );
  if (!novelRows[0]) {
    throw new Error("local novel: target novel is not local");
  }

  await db.execute(
    `UPDATE novel
     SET
       name       = $2,
       cover      = $3,
       summary    = $4,
       author     = $5,
       artist     = $6,
       status     = $7,
       genres     = $8,
       updated_at = unixepoch()
     WHERE id = $1
       AND plugin_id = $9
       AND is_local = 1`,
    [
      novelId,
      name,
      nullableLocalCover(input.cover),
      nullableText(input.summary),
      nullableText(input.author),
      nullableText(input.artist),
      nullableText(input.status),
      nullableText(input.genres),
      LOCAL_PLUGIN_ID,
    ],
  );
}

export async function upsertLocalNovelChapters(
  novelId: number,
  chapters: LocalNovelImportChapterInput[],
): Promise<LocalNovelImportResult> {
  return runDatabaseTransaction(async (db) => {
    await ensureLocalNovelExists(db, novelId);

    let changedChapters = 0;
    const chapterResult = await upsertDownloadedChaptersInDb(
      db,
      chapters.map((chapter) => ({
        novelId,
        path: chapter.path,
        name: chapter.name,
        position: chapter.position,
        chapterNumber: chapter.chapterNumber ?? null,
        page: chapter.page ?? "1",
        releaseTime: chapter.releaseTime ?? null,
        contentType: storedChapterContentType(
          normalizeChapterContentType(chapter.contentType),
        ),
        contentBytes: chapter.contentBytes,
      })),
    );
    changedChapters += chapterResult.rowsAffected;
    const deletedChapters = await deleteStaleLocalImportChapters(
      db,
      novelId,
      chapters,
    );
    changedChapters += deletedChapters;
    if (deletedChapters > 0) {
      const renumbered = await renumberLocalNovelChaptersWithDb(db, novelId);
      changedChapters += renumbered.rowsAffected;
    }

    await db.execute(
      `UPDATE novel
         SET updated_at = unixepoch()
         WHERE id = $1`,
      [novelId],
    );
    return {
      changed: changedChapters > 0,
      changedChapters,
      novelId,
      chapterCount: chapters.length,
    };
  });
}

export async function reorderLocalNovelChapters(
  novelId: number,
  chapterIds: number[],
): Promise<void> {
  const db = await getDb();
  await ensureLocalNovelExists(db, novelId);

  const chapterRows = await db.select<
    { chapterNumber: string | null; id: number; position: number }[]
  >(
    `SELECT id, position, chapter_number AS chapterNumber FROM chapter
     WHERE novel_id = $1
     ORDER BY position`,
    [novelId],
  );
  const existingChapterIds = chapterRows.map((chapter) => chapter.id);
  const requestedChapterIds = new Set(chapterIds);
  if (
    requestedChapterIds.size !== chapterIds.length ||
    existingChapterIds.length !== chapterIds.length ||
    existingChapterIds.some((chapterId) => !requestedChapterIds.has(chapterId))
  ) {
    throw new Error("local novel: reorder ids must match existing chapters");
  }

  const existingById = new Map(
    chapterRows.map((chapter) => [
      chapter.id,
      {
        chapterNumber: chapter.chapterNumber,
        position: chapter.position,
      },
    ]),
  );
  const changedEntries = chapterIds
    .map((chapterId, index) => ({
      chapterId,
      chapterNumber: String(index + 1),
      position: index + 1,
    }))
    .filter(({ chapterId, chapterNumber, position }) => {
      const existing = existingById.get(chapterId);
      return (
        existing?.position !== position ||
        existing.chapterNumber !== chapterNumber
      );
    });
  if (changedEntries.length === 0) return;

  const requestedValuesSql = changedEntries
    .map((_, index) => {
      const idParam = index * 3 + 1;
      const positionParam = idParam + 1;
      const chapterNumberParam = idParam + 2;
      return `($${idParam}, $${positionParam}, $${chapterNumberParam})`;
    })
    .join(", ");
  const novelIdParam = changedEntries.length * 3 + 1;
  const params = changedEntries.flatMap(
    ({ chapterId, position, chapterNumber }) => [
      chapterId,
      position,
      chapterNumber,
    ],
  );
  const result = await db.execute(
    `WITH requested(id, position, chapter_number) AS (VALUES ${requestedValuesSql})
     UPDATE chapter
     SET
       position = (
         SELECT requested.position
         FROM requested
         WHERE requested.id = chapter.id
       ),
       chapter_number = (
         SELECT requested.chapter_number
         FROM requested
         WHERE requested.id = chapter.id
       ),
       updated_at = unixepoch()
     WHERE novel_id = $${novelIdParam}
       AND id IN (SELECT id FROM requested)
       AND (
         position IS NOT (
           SELECT requested.position
           FROM requested
           WHERE requested.id = chapter.id
         )
         OR chapter_number IS NOT (
           SELECT requested.chapter_number
           FROM requested
           WHERE requested.id = chapter.id
         )
       )`,
    [...params, novelId],
  );
  if (result.rowsAffected !== changedEntries.length) {
    throw new Error("local novel: failed to update chapter order");
  }
}

export async function upsertLocalNovel(
  input: LocalNovelImportInput,
): Promise<LocalNovelImportResult> {
  return runDatabaseTransaction(async (db) => {
    const novelResult = await db.execute(
      `INSERT INTO novel
           (plugin_id, path, name, cover, summary, author, artist, status, genres, in_library, is_local, library_added_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1, unixepoch())
         ON CONFLICT(plugin_id, path) DO UPDATE SET
           name             = excluded.name,
           cover            = excluded.cover,
           summary          = excluded.summary,
           author           = excluded.author,
           artist           = excluded.artist,
           status           = excluded.status,
           genres           = excluded.genres,
           in_library       = 1,
           is_local         = 1,
           library_added_at = COALESCE(library_added_at, unixepoch()),
           updated_at       = unixepoch()
          WHERE
            name IS NOT excluded.name
            OR cover IS NOT excluded.cover
            OR summary IS NOT excluded.summary
            OR author IS NOT excluded.author
            OR artist IS NOT excluded.artist
            OR status IS NOT excluded.status
            OR genres IS NOT excluded.genres
            OR in_library IS NOT 1
            OR is_local IS NOT 1
            OR library_added_at IS NULL`,
      [
        LOCAL_PLUGIN_ID,
        input.path,
        input.name,
        nullableLocalCover(input.cover),
        input.summary ?? null,
        input.author ?? null,
        input.artist ?? null,
        input.status ?? null,
        input.genres ?? null,
      ],
    );

    const rows = await db.select<{ id: number }[]>(
      `SELECT id FROM novel WHERE plugin_id = $1 AND path = $2`,
      [LOCAL_PLUGIN_ID, input.path],
    );
    const novelId = rows[0]?.id;
    if (!novelId) {
      throw new Error("local import: failed to resolve local novel id");
    }

    let changedChapters = 0;
    const chapterResult = await upsertDownloadedChaptersInDb(
      db,
      input.chapters.map((chapter) => ({
        novelId,
        path: chapter.path,
        name: chapter.name,
        position: chapter.position,
        chapterNumber: chapter.chapterNumber ?? null,
        page: chapter.page ?? "1",
        releaseTime: chapter.releaseTime ?? null,
        contentType: storedChapterContentType(
          normalizeChapterContentType(chapter.contentType),
        ),
        contentBytes: chapter.contentBytes,
      })),
    );
    changedChapters += chapterResult.rowsAffected;
    const deletedChapters = await deleteStaleLocalImportChapters(
      db,
      novelId,
      input.chapters,
    );
    changedChapters += deletedChapters;
    if (deletedChapters > 0) {
      const renumbered = await renumberLocalNovelChaptersWithDb(db, novelId);
      changedChapters += renumbered.rowsAffected;
    }

    return {
      changed: novelResult.rowsAffected > 0 || changedChapters > 0,
      changedChapters,
      novelId,
      chapterCount: input.chapters.length,
    };
  });
}
