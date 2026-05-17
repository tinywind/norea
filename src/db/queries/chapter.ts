import {
  DEFAULT_CHAPTER_CONTENT_TYPE,
  normalizeChapterContentType,
  storedChapterContentType,
  type ChapterContentType,
} from "../../lib/chapter-content";
import { chapterMediaRepairFlag } from "../../lib/chapter-media-state";
import {
  MAX_CHAPTER_BULK_INPUT_ROWS,
  MAX_CHAPTER_TITLE_BYTES,
  MAX_CHAPTER_URL_BYTES,
  MAX_INLINE_IPC_BYTES,
  MAX_ROUTE_QUERY_ROWS,
  assertByteBudget,
  clampRouteQueryLimit,
} from "../../lib/performance-budgets";
import { getDb, runDatabaseTransaction } from "../client";

export interface ChapterRow {
  id: number;
  novelId: number;
  path: string;
  name: string;
  chapterNumber: string | null;
  position: number;
  page: string;
  bookmark: boolean;
  unread: boolean;
  progress: number;
  isDownloaded: boolean;
  content: string | null;
  contentType: ChapterContentType;
  contentBytes: number;
  mediaBytes: number;
  mediaRepairNeeded: boolean;
  releaseTime: string | null;
  readAt: number | null;
  createdAt: number | null;
  foundAt: number;
  updatedAt: number;
}

export type ChapterListRow = Omit<ChapterRow, "content">;

type RawChapterListRow = Omit<
  ChapterListRow,
  "bookmark" | "unread" | "isDownloaded" | "contentType" | "mediaRepairNeeded"
> & {
  bookmark: unknown;
  unread: unknown;
  isDownloaded: unknown;
  contentType: string | null;
  mediaRepairNeeded: unknown;
};

type RawChapterRow = RawChapterListRow & {
  content: string | null;
};

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
  content_type   AS contentType,
  content_bytes   AS contentBytes,
  media_bytes     AS mediaBytes,
  media_repair_needed AS mediaRepairNeeded,
  release_time   AS releaseTime,
  read_at        AS readAt,
  created_at     AS createdAt,
  found_at       AS foundAt,
  updated_at     AS updatedAt
`;

const CHAPTER_DETAIL_SELECT_FIELDS = `
  ${CHAPTER_LIST_SELECT_FIELDS},
  content
`;

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sqliteBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0" || normalized === "") {
      return false;
    }
  }
  return Boolean(value);
}

function normalizeChapterListRow(row: RawChapterListRow): ChapterListRow {
  return {
    ...row,
    bookmark: sqliteBoolean(row.bookmark),
    unread: sqliteBoolean(row.unread),
    isDownloaded: sqliteBoolean(row.isDownloaded),
    contentType: normalizeChapterContentType(row.contentType),
    mediaRepairNeeded: sqliteBoolean(row.mediaRepairNeeded),
  };
}

function normalizeChapterRow(row: RawChapterRow): ChapterRow {
  return {
    ...normalizeChapterListRow(row),
    content: row.content,
  };
}

export async function listChaptersByNovel(
  novelId: number,
): Promise<ChapterListRow[]> {
  const db = await getDb();
  const rows = await db.select<RawChapterListRow[]>(
    `SELECT ${CHAPTER_LIST_SELECT_FIELDS}
     FROM chapter
     WHERE novel_id = $1
     ORDER BY position`,
    [novelId],
  );
  return rows.map(normalizeChapterListRow);
}

export async function getChapterById(
  chapterId: number,
): Promise<ChapterRow | null> {
  const db = await getDb();
  const rows = await db.select<RawChapterRow[]>(
    `SELECT ${CHAPTER_DETAIL_SELECT_FIELDS}
     FROM chapter
     WHERE id = $1`,
    [chapterId],
  );
  return rows[0] ? normalizeChapterRow(rows[0]) : null;
}

export interface InsertChapterInput {
  novelId: number;
  path: string;
  name: string;
  position: number;
  chapterNumber?: string | null;
  page?: string;
  releaseTime?: string | null;
  contentType?: ChapterContentType;
}

export interface LatestSourceChapterAnchor {
  novelId: number;
  chapterNumber: number;
  position: number;
}

export interface ChapterMutationResult {
  rowsAffected: number;
}

export interface SaveChapterContentOptions {
  mediaBytes?: number;
}

export interface DownloadedChapterUpsertInput extends InsertChapterInput {
  content: string;
  contentBytes?: number;
}

export interface BulkChapterMutationResult extends ChapterMutationResult {
  chunks: number;
}

type DbHandle = Awaited<ReturnType<typeof getDb>>;

const SQLITE_BIND_PARAMETER_BUDGET = 900;
const SOURCE_CHAPTER_PARAM_COUNT = 8;
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

function assertChapterTextBudget(
  value: string,
  maxBytes: number,
  label: string,
): void {
  assertByteBudget(getUtf8ByteLength(value), maxBytes, label);
}

function assertChapterBulkCount(
  count: number,
  label: string,
): void {
  if (count > MAX_CHAPTER_BULK_INPUT_ROWS) {
    throw new Error(
      `${label} has ${count} chapters, which exceeds the ${MAX_CHAPTER_BULK_INPUT_ROWS} chapter limit.`,
    );
  }
}

function assertChapterMetadataBudget(
  input: InsertChapterInput,
  label: string,
): void {
  assertChapterTextBudget(input.name, MAX_CHAPTER_TITLE_BYTES, `${label} title`);
  assertChapterTextBudget(input.path, MAX_CHAPTER_URL_BYTES, `${label} URL`);
}

function validateSourceChapterInputs(
  inputs: readonly InsertChapterInput[],
): void {
  assertChapterBulkCount(inputs.length, "Chapter upsert");
  for (const input of inputs) {
    assertChapterMetadataBudget(input, "Chapter");
  }
}

function normalizedDownloadedChapterInput(
  input: DownloadedChapterUpsertInput,
): DownloadedChapterUpsertInput & { contentBytes: number } {
  assertChapterMetadataBudget(input, "Downloaded chapter");
  const contentBytes = getUtf8ByteLength(input.content);
  assertByteBudget(contentBytes, MAX_INLINE_IPC_BYTES, "Downloaded chapter content");
  if (
    input.contentBytes !== undefined &&
    (!Number.isFinite(input.contentBytes) ||
      input.contentBytes < 0 ||
      input.contentBytes > MAX_INLINE_IPC_BYTES)
  ) {
    assertByteBudget(
      Number.isFinite(input.contentBytes) ? input.contentBytes : -1,
      MAX_INLINE_IPC_BYTES,
      "Downloaded chapter content",
    );
  }
  return { ...input, contentBytes };
}

function validateDownloadedChapterInputs(
  inputs: readonly DownloadedChapterUpsertInput[],
): Array<DownloadedChapterUpsertInput & { contentBytes: number }> {
  assertChapterBulkCount(inputs.length, "Downloaded chapter upsert");
  return inputs.map(normalizedDownloadedChapterInput);
}

function sourceChapterValuesSql(inputs: readonly InsertChapterInput[]): string {
  return inputs
    .map((_, index) => {
      const param = index * SOURCE_CHAPTER_PARAM_COUNT + 1;
      return `($${param}, $${param + 1}, $${param + 2}, $${param + 3}, $${param + 4}, $${param + 5}, $${param + 6}, $${param + 7}, unixepoch(), unixepoch())`;
    })
    .join(", ");
}

function sourceChapterParams(inputs: readonly InsertChapterInput[]): unknown[] {
  return inputs.flatMap((input) => [
    input.novelId,
    input.path,
    input.name,
    input.position,
    input.chapterNumber ?? null,
    input.page ?? "1",
    input.releaseTime ?? null,
    normalizeChapterContentType(input.contentType),
  ]);
}

function downloadedChapterValuesSql(
  inputs: readonly DownloadedChapterUpsertInput[],
): string {
  return inputs
    .map((_, index) => {
      const param = index * DOWNLOADED_CHAPTER_PARAM_COUNT + 1;
      return `($${param}, $${param + 1}, $${param + 2}, $${param + 3}, $${param + 4}, $${param + 5}, $${param + 6}, $${param + 7}, $${param + 8}, $${param + 9}, 0, 1, unixepoch(), unixepoch())`;
    })
    .join(", ");
}

function downloadedChapterParams(
  inputs: ReadonlyArray<DownloadedChapterUpsertInput & { contentBytes: number }>,
): unknown[] {
  return inputs.flatMap((input) => [
    input.novelId,
    input.path,
    input.name,
    input.position,
    input.chapterNumber ?? null,
    input.page ?? "1",
    input.releaseTime ?? null,
    storedChapterContentType(normalizeChapterContentType(input.contentType)),
    input.content,
    input.contentBytes,
  ]);
}

function chapterChunks<T>(
  inputs: readonly T[],
  chunkSize: number,
): readonly T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < inputs.length; index += chunkSize) {
    chunks.push(inputs.slice(index, index + chunkSize));
  }
  return chunks;
}

async function executeSourceChapterChunk(
  db: DbHandle,
  chunk: readonly InsertChapterInput[],
): Promise<number> {
  const result = await db.execute(
    `INSERT INTO chapter
       (novel_id, path, name, position, chapter_number, page, release_time, content_type, created_at, found_at)
     VALUES ${sourceChapterValuesSql(chunk)}
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
    sourceChapterParams(chunk),
  );
  return result.rowsAffected;
}

async function executeDownloadedChapterChunk(
  db: DbHandle,
  chunk: ReadonlyArray<DownloadedChapterUpsertInput & { contentBytes: number }>,
): Promise<number> {
  const result = await db.execute(
    `INSERT INTO chapter
       (novel_id, path, name, position, chapter_number, page, release_time, content_type, content, content_bytes, media_repair_needed, is_downloaded, created_at, found_at)
     VALUES ${downloadedChapterValuesSql(chunk)}
     ON CONFLICT(novel_id, path) DO UPDATE SET
       name           = excluded.name,
       position       = excluded.position,
       chapter_number = excluded.chapter_number,
       page           = excluded.page,
       release_time   = excluded.release_time,
       content_type   = excluded.content_type,
       content        = excluded.content,
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
        OR content IS NOT excluded.content
        OR content_bytes IS NOT excluded.content_bytes
        OR media_repair_needed IS NOT 0
        OR is_downloaded IS NOT 1`,
    downloadedChapterParams(chunk),
  );
  return result.rowsAffected;
}

async function upsertSourceChaptersWithDb(
  db: DbHandle,
  inputs: readonly InsertChapterInput[],
): Promise<BulkChapterMutationResult> {
  if (inputs.length === 0) return { rowsAffected: 0, chunks: 0 };
  validateSourceChapterInputs(inputs);

  let rowsAffected = 0;
  let chunks = 0;
  for (const chunk of chapterChunks(inputs, SOURCE_CHAPTER_CHUNK_SIZE)) {
    rowsAffected += await executeSourceChapterChunk(db, chunk);
    chunks += 1;
  }
  return { rowsAffected, chunks };
}

export async function upsertSourceChaptersInDb(
  db: DbHandle,
  inputs: readonly InsertChapterInput[],
): Promise<BulkChapterMutationResult> {
  return upsertSourceChaptersWithDb(db, inputs);
}

export async function upsertSourceChapters(
  inputs: readonly InsertChapterInput[],
): Promise<BulkChapterMutationResult> {
  validateSourceChapterInputs(inputs);
  return runDatabaseTransaction((db) => upsertSourceChaptersWithDb(db, inputs));
}

async function upsertDownloadedChaptersWithDb(
  db: DbHandle,
  inputs: readonly DownloadedChapterUpsertInput[],
): Promise<BulkChapterMutationResult> {
  if (inputs.length === 0) return { rowsAffected: 0, chunks: 0 };
  const normalizedInputs = validateDownloadedChapterInputs(inputs);

  let rowsAffected = 0;
  let chunks = 0;
  for (const chunk of chapterChunks(
    normalizedInputs,
    DOWNLOADED_CHAPTER_CHUNK_SIZE,
  )) {
    rowsAffected += await executeDownloadedChapterChunk(db, chunk);
    chunks += 1;
  }
  return { rowsAffected, chunks };
}

export async function upsertDownloadedChaptersInDb(
  db: DbHandle,
  inputs: readonly DownloadedChapterUpsertInput[],
): Promise<BulkChapterMutationResult> {
  return upsertDownloadedChaptersWithDb(db, inputs);
}

export async function upsertDownloadedChapters(
  inputs: readonly DownloadedChapterUpsertInput[],
): Promise<BulkChapterMutationResult> {
  validateDownloadedChapterInputs(inputs);
  return runDatabaseTransaction((db) =>
    upsertDownloadedChaptersWithDb(db, inputs),
  );
}

export async function insertChapterIfAbsent(
  input: InsertChapterInput,
): Promise<void> {
  const db = await getDb();
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
}

export async function getLatestSourceChapterAnchor(
  novelId: number,
): Promise<LatestSourceChapterAnchor | null> {
  const db = await getDb();
  const rows = await db.select<
    { chapterNumber: string | null; position: number }[]
  >(
    `SELECT chapter_number AS chapterNumber, position
     FROM chapter
     WHERE novel_id = $1`,
    [novelId],
  );
  if (rows.length === 0) return null;

  let latest: LatestSourceChapterAnchor | null = null;
  for (const row of rows) {
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

export async function upsertChapter(
  input: InsertChapterInput,
): Promise<ChapterMutationResult> {
  const db = await getDb();
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
  return { rowsAffected: result.rowsAffected };
}

export async function updateChapterProgress(
  chapterId: number,
  progress: number,
  options: { recordHistory?: boolean } = {},
): Promise<void> {
  const db = await getDb();
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  const recordHistory = options.recordHistory ?? true;
  if (recordHistory) {
    await db.execute(
      `UPDATE chapter
       SET
         progress   = $2,
         unread     = CASE WHEN $2 >= 100 THEN 0 ELSE unread END,
         read_at    = CASE WHEN $2 > 0 THEN unixepoch() ELSE read_at END,
         updated_at = unixepoch()
       WHERE id = $1`,
      [chapterId, clamped],
    );
    await db.execute(
      `UPDATE novel
       SET last_read_at = unixepoch(), updated_at = unixepoch()
       WHERE id = (
         SELECT novel_id FROM chapter WHERE id = $1
       )`,
      [chapterId],
    );
    return;
  }

  await db.execute(
    `UPDATE chapter
     SET
       progress   = $2,
       unread     = CASE WHEN $2 >= 100 THEN 0 ELSE unread END,
       updated_at = unixepoch()
     WHERE id = $1`,
    [chapterId, clamped],
  );
}

export async function markChapterOpened(chapterId: number): Promise<void> {
  const db = await getDb();
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
}

export async function clearNovelHistory(novelId: number): Promise<void> {
  const db = await getDb();
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
}

export async function setChapterBookmark(
  chapterId: number,
  bookmarked: boolean,
): Promise<void> {
  const db = await getDb();
  const bookmarkFlag = bookmarked ? 1 : 0;
  await db.execute(
    `UPDATE chapter
     SET bookmark = $2, updated_at = unixepoch()
     WHERE id = $1`,
    [chapterId, bookmarkFlag],
  );
}

export async function saveChapterContent(
  chapterId: number,
  html: string,
  contentType: ChapterContentType = DEFAULT_CHAPTER_CONTENT_TYPE,
  options: SaveChapterContentOptions = {},
): Promise<ChapterMutationResult> {
  const db = await getDb();
  const normalizedContentType = storedChapterContentType(
    normalizeChapterContentType(contentType),
  );
  const result = await db.execute(
    `UPDATE chapter
     SET
       content        = $2,
       content_type   = $3,
       content_bytes  = $4,
       media_bytes    = $5,
       media_repair_needed = $6,
       media_bytes_checked_at = CASE WHEN $7 = 1 THEN unixepoch() ELSE NULL END,
       is_downloaded  = 1,
       updated_at     = unixepoch()
     WHERE id = $1`,
    [
      chapterId,
      html,
      normalizedContentType,
      getUtf8ByteLength(html),
      options.mediaBytes ?? 0,
      chapterMediaRepairFlag(html, normalizedContentType),
      options.mediaBytes === undefined ? 0 : 1,
    ],
  );
  return { rowsAffected: result.rowsAffected };
}

export async function saveChapterPartialContent(
  chapterId: number,
  html: string,
  contentType: ChapterContentType = DEFAULT_CHAPTER_CONTENT_TYPE,
): Promise<ChapterMutationResult> {
  const db = await getDb();
  const normalizedContentType = storedChapterContentType(
    normalizeChapterContentType(contentType),
  );
  const result = await db.execute(
    `UPDATE chapter
     SET
       content        = $2,
       content_type   = $3,
       content_bytes  = $4,
       media_repair_needed = $5,
       media_bytes_checked_at = NULL,
       updated_at     = unixepoch()
     WHERE id = $1`,
    [
      chapterId,
      html,
      normalizedContentType,
      getUtf8ByteLength(html),
      chapterMediaRepairFlag(html, normalizedContentType),
    ],
  );
  return { rowsAffected: result.rowsAffected };
}

export async function getChapterContent(
  chapterId: number,
): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ content: string | null }[]>(
    `SELECT content FROM chapter WHERE id = $1`,
    [chapterId],
  );
  return rows[0]?.content ?? null;
}

export async function clearChapterContent(
  chapterId: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE chapter
     SET
       content        = NULL,
       content_bytes  = 0,
       media_bytes    = 0,
       media_repair_needed = 0,
       media_bytes_checked_at = NULL,
       is_downloaded  = 0,
       updated_at     = unixepoch()
     WHERE id = $1
       AND novel_id IN (
         SELECT id
         FROM novel
         WHERE is_local = 0
       )`,
    [chapterId],
  );
}

/**
 * One unread chapter for a novel that's currently in the library.
 * This is the row shape powering the Updates tab.
 */
export interface LibraryUpdateEntry {
  chapterId: number;
  chapterPath: string;
  novelId: number;
  pluginId: string;
  novelPath: string;
  chapterName: string;
  contentType: ChapterContentType;
  position: number;
  foundAt: number;
  isDownloaded: boolean;
  novelName: string;
  novelCover: string | null;
}

interface RawLibraryUpdate
  extends Omit<LibraryUpdateEntry, "contentType" | "isDownloaded"> {
  contentType: string;
  isDownloaded: number;
}

const DEFAULT_UPDATES_LIMIT = Math.min(100, MAX_ROUTE_QUERY_ROWS);

export interface LibraryUpdatesPage {
  hasMore: boolean;
  nextCursor: LibraryUpdatesCursor | null;
  updates: LibraryUpdateEntry[];
}

export interface LibraryUpdatesCursor {
  chapterId: number;
  foundAt: number;
  position: number;
}

function getUpdatesCursor(
  entry: LibraryUpdateEntry | undefined,
): LibraryUpdatesCursor | null {
  if (!entry) return null;
  return {
    chapterId: entry.chapterId,
    foundAt: entry.foundAt,
    position: entry.position,
  };
}

/**
 * Unread chapters currently indexed for novels in the library.
 * The Updates tab calls a user-triggered source refresh; this query
 * only reads the resulting local index.
 */
export async function listLibraryUpdates(
  limit: number = DEFAULT_UPDATES_LIMIT,
  cursor: LibraryUpdatesCursor | null = null,
): Promise<LibraryUpdateEntry[]> {
  const db = await getDb();
  const normalizedLimit = clampRouteQueryLimit(limit, DEFAULT_UPDATES_LIMIT);
  const cursorClause = cursor
    ? `AND (
         c.found_at < $1
         OR (c.found_at = $1 AND c.position < $2)
         OR (c.found_at = $1 AND c.position = $2 AND c.id < $3)
       )`
    : "";
  const params = cursor
    ? [cursor.foundAt, cursor.position, cursor.chapterId, normalizedLimit]
    : [normalizedLimit];
  const limitParam = cursor ? "$4" : "$1";
  const rows = await db.select<RawLibraryUpdate[]>(
    `SELECT
       c.id              AS chapterId,
       c.path            AS chapterPath,
       c.novel_id        AS novelId,
       n.plugin_id       AS pluginId,
       n.path            AS novelPath,
       c.name            AS chapterName,
       c.content_type    AS contentType,
       c.position,
       c.found_at        AS foundAt,
       c.is_downloaded   AS isDownloaded,
       n.name            AS novelName,
       n.cover           AS novelCover
     FROM chapter c
     JOIN novel n ON n.id = c.novel_id
     WHERE
       n.in_library = 1
       AND c.unread = 1
       ${cursorClause}
      ORDER BY foundAt DESC, c.position DESC, c.id DESC
      LIMIT ${limitParam}`,
    params,
  );
  return rows.map((row) => ({
    ...row,
    contentType: normalizeChapterContentType(row.contentType),
    isDownloaded: !!row.isDownloaded,
  }));
}

export async function listLibraryUpdatesPage(
  limit: number = DEFAULT_UPDATES_LIMIT,
  cursor: LibraryUpdatesCursor | null = null,
): Promise<LibraryUpdatesPage> {
  const normalizedLimit = clampRouteQueryLimit(limit, DEFAULT_UPDATES_LIMIT);
  const rows = await listLibraryUpdates(
    normalizedLimit + 1,
    cursor,
  );
  const updates = rows.slice(0, normalizedLimit);
  const hasMore = rows.length > normalizedLimit;
  return {
    hasMore,
    nextCursor: hasMore ? getUpdatesCursor(updates.at(-1)) : null,
    updates,
  };
}

/** One chapter recently read, joined with its parent novel for display. */
export interface RecentlyReadEntry {
  chapterId: number;
  novelId: number;
  chapterName: string;
  position: number;
  readAt: number;
  progress: number;
  novelName: string;
  novelCover: string | null;
}

const DEFAULT_HISTORY_LIMIT = Math.min(100, MAX_ROUTE_QUERY_ROWS);

/**
 * Latest read chapter per novel, sorted by read timestamp descending.
 * Excludes novels with no recorded reading history.
 */
export async function listRecentlyRead(
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<RecentlyReadEntry[]> {
  const db = await getDb();
  const normalizedLimit = clampRouteQueryLimit(limit, DEFAULT_HISTORY_LIMIT);
  return db.select<RecentlyReadEntry[]>(
    `SELECT
       c.id              AS chapterId,
       c.novel_id        AS novelId,
       c.name            AS chapterName,
       c.position,
       c.read_at         AS readAt,
       c.progress,
       n.name            AS novelName,
       n.cover           AS novelCover
     FROM chapter c
     JOIN novel n ON n.id = c.novel_id
     WHERE c.id = (
       SELECT c2.id
       FROM chapter c2
       WHERE c2.novel_id = c.novel_id AND c2.read_at IS NOT NULL
       ORDER BY c2.read_at DESC, c2.position DESC, c2.id DESC
       LIMIT 1
     )
     ORDER BY c.read_at DESC, c.position DESC, c.id DESC
     LIMIT $1`,
    [normalizedLimit],
  );
}

export async function getAdjacentChapter(
  novelId: number,
  position: number,
  direction: 1 | -1,
): Promise<ChapterListRow | null> {
  const db = await getDb();
  const sql =
    direction === 1
      ? `SELECT ${CHAPTER_LIST_SELECT_FIELDS}
         FROM chapter
         WHERE novel_id = $1 AND position > $2
         ORDER BY position ASC
         LIMIT 1`
      : `SELECT ${CHAPTER_LIST_SELECT_FIELDS}
         FROM chapter
         WHERE novel_id = $1 AND position < $2
         ORDER BY position DESC
         LIMIT 1`;
  const rows = await db.select<RawChapterListRow[]>(sql, [novelId, position]);
  return rows[0] ? normalizeChapterListRow(rows[0]) : null;
}
