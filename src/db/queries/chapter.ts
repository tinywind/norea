import {
  DEFAULT_CHAPTER_CONTENT_TYPE,
  normalizeChapterContentType,
  storedChapterContentType,
  type ChapterContentType,
} from "../../lib/chapter-content";
import { chapterMediaRepairFlag } from "../../lib/chapter-media-state";
import type { ChapterSourceSnapshot } from "../../lib/chapter-composition";
import {
  MAX_CHAPTER_BULK_INPUT_ROWS,
  MAX_CHAPTER_TITLE_BYTES,
  MAX_CHAPTER_URL_BYTES,
  MAX_INLINE_IPC_BYTES,
  MAX_ROUTE_QUERY_ROWS,
  assertByteBudget,
  clampRouteQueryLimit,
} from "../../lib/performance-budgets";
import type { DatabaseReadMode } from "../client";
import { invokeDbMutation, invokeDbQuery } from "../ipc";

export async function findLocalImportedChapter(
  pathKey: string,
): Promise<{ id: number; novelId: number } | null> {
  return invokeDbQuery<{ id: number; novelId: number } | null>(
    "db_chapter_find_local_imported",
    { pathKey },
  );
}

export interface ChapterRow {
  id: number;
  novelId: number;
  path: string;
  name: string;
  chapterNumber: string | null;
  /** User-facing number in a composed list; chapterNumber remains the package key. */
  displayChapterNumber?: string | null;
  compositionSource?: ChapterSourceSnapshot;
  position: number;
  page: string;
  bookmark: boolean;
  unread: boolean;
  progress: number;
  isDownloaded: boolean;
  sourceContentType: ChapterContentType;
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

export type ChapterListRow = ChapterRow;

export function hasStoredChapterContent(
  chapter: Pick<ChapterListRow, "isDownloaded" | "contentBytes">,
): boolean {
  return chapter.isDownloaded || chapter.contentBytes > 0;
}

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export async function listChaptersByNovel(
  novelId: number,
  readMode: DatabaseReadMode = "queued",
): Promise<ChapterListRow[]> {
  return invokeDbQuery<ChapterListRow[]>("db_chapter_list_by_novel", {
    novelId,
    readMode,
  });
}

export interface LibraryDownloadChapter extends ChapterListRow {
  isDownloadQueued: boolean;
}

export async function listLibraryDownloadChapters(
  novelId: number,
): Promise<LibraryDownloadChapter[]> {
  return invokeDbQuery<LibraryDownloadChapter[]>(
    "db_chapter_list_library_download",
    { novelId },
  );
}

/** One page, in id order, of a source novel's chapters with no stored body and no persisted download. */
export async function listUnqueuedChapterDownloads(
  novelId: number,
  afterChapterId = 0,
): Promise<ChapterListRow[]> {
  return invokeDbQuery<ChapterListRow[]>(
    "db_chapter_list_unqueued_downloads",
    { novelId, afterChapterId },
  );
}

export async function getChapterById(
  chapterId: number,
  readMode: DatabaseReadMode = "queued",
): Promise<ChapterRow | null> {
  return invokeDbQuery<ChapterRow | null>("db_chapter_get_by_id", {
    chapterId,
    readMode,
  });
}

export async function listExistingChapterIds(
  chapterIds: readonly number[],
): Promise<number[]> {
  if (chapterIds.length === 0) return [];
  return invokeDbQuery<number[]>("db_chapter_list_existing_ids", {
    chapterIds: [...new Set(chapterIds)],
  });
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
  contentBytes?: number;
}

export interface BulkChapterMutationResult extends ChapterMutationResult {
  chunks: number;
}

function assertChapterTextBudget(
  value: string,
  maxBytes: number,
  label: string,
): void {
  assertByteBudget(getUtf8ByteLength(value), maxBytes, label);
}

function assertChapterBulkCount(count: number, label: string): void {
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

function normalizeInsertChapterInput(input: InsertChapterInput) {
  return {
    novelId: input.novelId,
    path: input.path,
    name: input.name,
    position: input.position,
    chapterNumber: input.chapterNumber ?? null,
    page: input.page ?? "1",
    releaseTime: input.releaseTime ?? null,
    contentType: normalizeChapterContentType(input.contentType),
  };
}

function validateSourceChapterInputs(inputs: readonly InsertChapterInput[]) {
  assertChapterBulkCount(inputs.length, "Chapter upsert");
  return inputs.map((input) => {
    assertChapterMetadataBudget(input, "Chapter");
    return normalizeInsertChapterInput(input);
  });
}

function normalizedDownloadedChapterInput(input: DownloadedChapterUpsertInput) {
  assertChapterMetadataBudget(input, "Downloaded chapter");
  const contentBytes = input.contentBytes ?? 0;
  if (
    !Number.isFinite(contentBytes) ||
    contentBytes < 0 ||
    contentBytes > MAX_INLINE_IPC_BYTES
  ) {
    assertByteBudget(
      Number.isFinite(contentBytes) ? contentBytes : -1,
      MAX_INLINE_IPC_BYTES,
      "Downloaded chapter content",
    );
  }
  return {
    ...normalizeInsertChapterInput(input),
    contentBytes,
  };
}

function validateDownloadedChapterInputs(
  inputs: readonly DownloadedChapterUpsertInput[],
) {
  assertChapterBulkCount(inputs.length, "Downloaded chapter upsert");
  return inputs.map(normalizedDownloadedChapterInput);
}

export async function upsertSourceChapters(
  inputs: readonly InsertChapterInput[],
  options: { remoteContentSync?: boolean } = {},
): Promise<BulkChapterMutationResult> {
  const normalized = validateSourceChapterInputs(inputs);
  if (normalized.length === 0) return { rowsAffected: 0, chunks: 0 };
  return invokeDbMutation<BulkChapterMutationResult>(
    "db_chapter_upsert_source",
    {
      inputs: normalized,
      ...(options.remoteContentSync ? { remoteContentSync: true } : {}),
    },
  );
}

export async function upsertDownloadedChapters(
  inputs: readonly DownloadedChapterUpsertInput[],
): Promise<BulkChapterMutationResult> {
  const normalized = validateDownloadedChapterInputs(inputs);
  if (normalized.length === 0) return { rowsAffected: 0, chunks: 0 };
  return invokeDbMutation<BulkChapterMutationResult>(
    "db_chapter_upsert_downloaded",
    { inputs: normalized },
  );
}

export async function insertChapterIfAbsent(
  input: InsertChapterInput,
): Promise<void> {
  await invokeDbMutation<null>("db_chapter_insert_if_absent", {
    input: normalizeInsertChapterInput(input),
  });
}

export async function getLatestSourceChapterAnchor(
  novelId: number,
): Promise<LatestSourceChapterAnchor | null> {
  return invokeDbQuery<LatestSourceChapterAnchor | null>(
    "db_chapter_get_latest_source_anchor",
    { novelId },
  );
}

export async function upsertChapter(
  input: InsertChapterInput,
): Promise<ChapterMutationResult> {
  return invokeDbMutation<ChapterMutationResult>("db_chapter_upsert", {
    input: normalizeInsertChapterInput(input),
  });
}

/**
 * Reader position saves never lower a finished chapter: reopening it lands near the end and
 * lazily loaded images then shift that position, which would otherwise overwrite "read" with
 * a partial value. Explicit read-state changes go through setChaptersReadState instead.
 */
export async function updateChapterProgress(
  chapterId: number,
  progress: number,
  options: { recordHistory?: boolean } = {},
): Promise<void> {
  await invokeDbMutation<null>("db_chapter_update_progress", {
    input: {
      chapterId,
      progress,
      recordHistory: options.recordHistory ?? true,
    },
  });
}

/** A chapter's read flag and progress, as captured before a bulk read-state change. */
export interface ChapterReadState {
  id: number;
  progress: number;
  unread: boolean;
}

export async function setChaptersReadState(
  chapterIds: readonly number[],
  unread: boolean,
): Promise<BulkChapterMutationResult & { previous: ChapterReadState[] }> {
  const uniqueChapterIds = Array.from(new Set(chapterIds)).filter(
    (chapterId) => Number.isInteger(chapterId) && chapterId > 0,
  );
  if (uniqueChapterIds.length === 0) {
    return { rowsAffected: 0, chunks: 0, previous: [] };
  }
  assertChapterBulkCount(uniqueChapterIds.length, "Chapter read state update");
  return invokeDbMutation<
    BulkChapterMutationResult & { previous: ChapterReadState[] }
  >("db_chapter_set_read_state", {
    input: { chapterIds: uniqueChapterIds, unread },
  });
}

/** Marks every chapter of the given novels read or unread and captures the chapters it changed. */
export async function setNovelsReadState(
  novelIds: readonly number[],
  unread: boolean,
): Promise<BulkChapterMutationResult & { previous: ChapterReadState[] }> {
  const uniqueNovelIds = Array.from(new Set(novelIds)).filter(
    (novelId) => Number.isInteger(novelId) && novelId > 0,
  );
  if (uniqueNovelIds.length === 0) {
    return { rowsAffected: 0, chunks: 0, previous: [] };
  }
  return invokeDbMutation<
    BulkChapterMutationResult & { previous: ChapterReadState[] }
  >("db_chapter_set_novels_read_state", {
    input: { novelIds: uniqueNovelIds, unread },
  });
}

/** Puts back each chapter's read flag and progress exactly as captured, in chunks of equal values. */
export async function restoreChapterReadStates(
  states: readonly ChapterReadState[],
): Promise<BulkChapterMutationResult> {
  const validStates = states.filter(
    (state) => Number.isInteger(state.id) && state.id > 0,
  );
  if (validStates.length === 0) return { rowsAffected: 0, chunks: 0 };
  assertChapterBulkCount(states.length, "Chapter read state restore");
  return invokeDbMutation<BulkChapterMutationResult>(
    "db_chapter_restore_read_states",
    { states: validStates },
  );
}

export type RelativeChapterDirection = "before" | "after";

export async function setRelativeChaptersReadState(
  anchorChapterId: number,
  direction: RelativeChapterDirection,
  unread: boolean,
): Promise<ChapterMutationResult & { previous: ChapterReadState[] }> {
  if (!Number.isInteger(anchorChapterId) || anchorChapterId <= 0) {
    return { rowsAffected: 0, previous: [] };
  }
  return invokeDbMutation<
    ChapterMutationResult & { previous: ChapterReadState[] }
  >("db_chapter_set_relative_read_state", {
    input: { anchorChapterId, direction, unread },
  });
}

export async function markChapterOpened(chapterId: number): Promise<void> {
  await invokeDbMutation<null>("db_chapter_mark_opened", { chapterId });
}

export async function clearNovelHistory(novelId: number): Promise<void> {
  await invokeDbMutation<null>("db_chapter_clear_novel_history", { novelId });
}

export async function setChapterBookmark(
  chapterId: number,
  bookmarked: boolean,
): Promise<void> {
  await invokeDbMutation<null>("db_chapter_set_bookmark", {
    chapterId,
    bookmarked,
  });
}

export async function saveChapterContentMetadata(
  chapterId: number,
  html: string,
  contentType: ChapterContentType = DEFAULT_CHAPTER_CONTENT_TYPE,
  options: SaveChapterContentOptions = {},
): Promise<ChapterMutationResult> {
  const normalizedContentType = storedChapterContentType(
    normalizeChapterContentType(contentType),
  );
  return invokeDbMutation<ChapterMutationResult>(
    "db_chapter_save_content_metadata",
    {
      input: {
        chapterId,
        contentBytes: getUtf8ByteLength(html),
        contentType: normalizedContentType,
        ...(options.mediaBytes !== undefined
          ? { mediaBytes: options.mediaBytes }
          : {}),
        mediaRepairNeeded: Boolean(
          chapterMediaRepairFlag(html, normalizedContentType),
        ),
      },
    },
  );
}

export async function saveChapterPartialContentMetadata(
  chapterId: number,
  html: string,
  contentType: ChapterContentType = DEFAULT_CHAPTER_CONTENT_TYPE,
): Promise<ChapterMutationResult> {
  const normalizedContentType = storedChapterContentType(
    normalizeChapterContentType(contentType),
  );
  return invokeDbMutation<ChapterMutationResult>(
    "db_chapter_save_partial_content_metadata",
    {
      input: {
        chapterId,
        contentBytes: getUtf8ByteLength(html),
        contentType: normalizedContentType,
        mediaRepairNeeded: Boolean(
          chapterMediaRepairFlag(html, normalizedContentType),
        ),
      },
    },
  );
}

export async function markChapterMediaRepairPending(
  chapterId: number,
): Promise<ChapterMutationResult> {
  return invokeDbMutation<ChapterMutationResult>(
    "db_chapter_mark_media_repair_pending",
    { chapterId },
  );
}

export async function adoptStoredChapterContentMetadata(
  chapterId: number,
  contentBytes: number,
  mediaBytes: number,
  contentType: ChapterContentType | null,
  mediaRepairNeeded = false,
): Promise<ChapterMutationResult> {
  const normalizedContentType = contentType
    ? storedChapterContentType(normalizeChapterContentType(contentType))
    : null;
  return invokeDbMutation<ChapterMutationResult>(
    "db_chapter_adopt_stored_content_metadata",
    {
      input: {
        chapterId,
        contentBytes,
        mediaBytes,
        contentType: normalizedContentType,
        mediaRepairNeeded,
      },
    },
  );
}

export async function markStoredChapterContentMissing(
  chapterId: number,
): Promise<ChapterMutationResult> {
  return invokeDbMutation<ChapterMutationResult>(
    "db_chapter_mark_stored_content_missing",
    { chapterId },
  );
}

export async function clearChapterContent(chapterId: number): Promise<void> {
  await invokeDbMutation<null>("db_chapter_clear_content", { chapterId });
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
  pluginName?: string | null;
  novelSourceNovelId: string | null;
  novelPath: string;
  chapterName: string;
  contentType: ChapterContentType;
  position: number;
  /**
   * Unix seconds the row sorts and groups by: in the new-chapters list, the source's release time
   * when the plugin gave a parseable date no later than the find; otherwise when it was found.
   */
  sortAt: number;
  isDownloaded: boolean;
  novelName: string;
  novelCover: string | null;
  novelCoverOverride?: string | null;
  novelIsLocal: boolean;
}

const DEFAULT_UPDATES_LIMIT = Math.min(100, MAX_ROUTE_QUERY_ROWS);

export interface LibraryUpdatesPage {
  hasMore: boolean;
  nextCursor: LibraryUpdatesCursor | null;
  updates: LibraryUpdateEntry[];
}

export interface LibraryUpdatesCursor {
  chapterId: number;
  sortAt: number;
  position: number;
}

function getUpdatesCursor(
  entry: LibraryUpdateEntry | undefined,
): LibraryUpdatesCursor | null {
  if (!entry) return null;
  return {
    chapterId: entry.chapterId,
    sortAt: entry.sortAt,
    position: entry.position,
  };
}

/**
 * "new": unread library chapters that checks for new chapters found; "backlog": every unread
 * library chapter. Reads only the local index that checks keep current.
 */
export type LibraryUpdatesScope = "new" | "backlog";

export async function listLibraryUpdates(
  limit: number = DEFAULT_UPDATES_LIMIT,
  cursor: LibraryUpdatesCursor | null = null,
  scope: LibraryUpdatesScope = "new",
  readMode: DatabaseReadMode = "queued",
): Promise<LibraryUpdateEntry[]> {
  const normalizedLimit = clampRouteQueryLimit(limit, DEFAULT_UPDATES_LIMIT);
  return invokeDbQuery<LibraryUpdateEntry[]>(
    "db_chapter_list_library_updates",
    {
      input: { limit: normalizedLimit, cursor, scope },
      readMode,
    },
  );
}

/** Unread chapters found by checks since `seenAt` (Unix seconds), for the Updates badge. */
export async function countNewLibraryChaptersSince(
  seenAt: number,
  readMode: DatabaseReadMode = "queued",
): Promise<number> {
  return invokeDbQuery<number>("db_chapter_count_new_since", {
    seenAt,
    readMode,
  });
}

export async function listLibraryUpdatesPage(
  limit: number = DEFAULT_UPDATES_LIMIT,
  cursor: LibraryUpdatesCursor | null = null,
  scope: LibraryUpdatesScope = "new",
  readMode: DatabaseReadMode = "queued",
): Promise<LibraryUpdatesPage> {
  const normalizedLimit = clampRouteQueryLimit(limit, DEFAULT_UPDATES_LIMIT);
  const rows = await listLibraryUpdates(
    normalizedLimit + 1,
    cursor,
    scope,
    readMode,
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
  displayChapterNumber?: string | null;
  compositionSource?: ChapterSourceSnapshot;
  chapterPath?: string;
  chapterId: number;
  novelId: number;
  chapterName: string;
  chapterNumber: string | null;
  position: number;
  readAt: number;
  progress: number;
  pluginId: string;
  novelSourceNovelId: string | null;
  novelName: string;
  novelCover: string | null;
  novelCoverOverride?: string | null;
  novelInLibrary: boolean;
  novelIsLocal: boolean;
  novelPath: string;
}

const DEFAULT_HISTORY_LIMIT = Math.min(100, MAX_ROUTE_QUERY_ROWS);

/**
 * Latest read chapter per novel, sorted by read timestamp descending.
 * Excludes novels with no recorded reading history.
 */
export async function listRecentlyRead(
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<RecentlyReadEntry[]> {
  const normalizedLimit = clampRouteQueryLimit(limit, DEFAULT_HISTORY_LIMIT);
  return invokeDbQuery<RecentlyReadEntry[]>("db_chapter_list_recently_read", {
    limit: normalizedLimit,
  });
}

export async function getAdjacentChapter(
  novelId: number,
  position: number,
  direction: 1 | -1,
): Promise<ChapterListRow | null> {
  return invokeDbQuery<ChapterListRow | null>("db_chapter_get_adjacent", {
    novelId,
    position,
    direction,
  });
}
