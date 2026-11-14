import type { DatabaseReadMode } from "../client";
import { invokeDbMutation, invokeDbQuery } from "../ipc";
import {
  normalizeChapterContentType,
  type ChapterContentType,
} from "../../lib/chapter-content";
import type { EpubHtmlResource } from "../../lib/epub-html";
import type { LocalImportBinaryResource } from "../../lib/local-import";
import {
  clampRouteQueryLimit,
  MAX_ROUTE_QUERY_ROWS,
} from "../../lib/performance-budgets";
import type { LibrarySortOrder } from "../../store/library";

export const LOCAL_PLUGIN_ID = "local";

/**
 * Shape returned by the Library list query.
 */
export interface LibraryNovel {
  id: number;
  pluginId: string;
  pluginName?: string | null;
  sourceNovelId: string | null;
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
  repairNeededOnly?: boolean;
  /** Restrict to one source plugin id. */
  sourceId?: string | null;
  unreadOnly?: boolean;
  localOnly?: boolean;
  completedOnly?: boolean;
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
  repairNeededNovels: number;
  totalChapters: number;
  totalNovels: number;
  unreadChapters: number;
  unreadNovels: number;
}

export interface LibrarySourceFilter {
  pluginId: string;
  pluginName: string | null;
  totalNovels: number;
}

export interface LibraryNovelIdentity {
  pluginId: string;
  path: string;
}

interface LibraryNovelPageFilter extends LibraryFilter {
  cursor?: LibraryNovelCursor | null;
}

export interface LibraryNovelRefreshTarget {
  id: number;
  pluginId: string;
  path: string;
  name: string;
  cover: string | null;
  isLocal: boolean;
}

export type LibraryNovelRefreshFilter = Pick<
  LibraryFilter,
  | "search"
  | "categoryId"
  | "downloadedOnly"
  | "repairNeededOnly"
  | "sourceId"
  | "unreadOnly"
  | "localOnly"
  | "completedOnly"
>;

const DEFAULT_LIBRARY_PAGE_LIMIT = Math.min(100, MAX_ROUTE_QUERY_ROWS);

function sanitizeLibraryFilter(filter: LibraryFilter): LibraryFilter {
  if (filter.limit === undefined) return filter;
  return {
    ...filter,
    limit: clampRouteQueryLimit(filter.limit),
  };
}

export async function listLibraryNovels(
  filter: LibraryFilter = {},
): Promise<LibraryNovel[]> {
  return invokeDbQuery<LibraryNovel[]>("db_novel_list_library", {
    filter: sanitizeLibraryFilter(filter),
    mode: "queued",
  });
}

export async function listLibraryNovelIds(
  filter: LibraryNovelRefreshFilter = {},
): Promise<number[]> {
  return invokeDbQuery<number[]>("db_novel_list_library_ids", {
    filter,
    mode: "queued",
  });
}

export async function listLibraryNovelIdentities(): Promise<
  LibraryNovelIdentity[]
> {
  return invokeDbQuery<LibraryNovelIdentity[]>(
    "db_novel_list_library_identities",
    { mode: "queued" },
  );
}

export async function listLibraryNovelPage(
  filter: LibraryNovelPageFilter = {},
  readMode: DatabaseReadMode = "queued",
): Promise<LibraryNovelPage> {
  const normalizedLimit = clampRouteQueryLimit(
    filter.limit ?? DEFAULT_LIBRARY_PAGE_LIMIT,
    DEFAULT_LIBRARY_PAGE_LIMIT,
  );
  return invokeDbQuery<LibraryNovelPage>("db_novel_list_library_page", {
    filter: {
      ...filter,
      limit: normalizedLimit,
    },
    mode: readMode,
  });
}

export async function getLibraryNovelSummary(
  filter: LibraryFilter = {},
  readMode: DatabaseReadMode = "queued",
): Promise<LibraryNovelSummary> {
  return invokeDbQuery<LibraryNovelSummary>("db_novel_get_library_summary", {
    filter: sanitizeLibraryFilter(filter),
    mode: readMode,
  });
}

/** Stored chapters of exactly these works, counted like the library's downloaded totals. */
export async function countLibraryStoredChapters(
  novelIds: readonly number[],
  readMode: DatabaseReadMode = "queued",
): Promise<number> {
  const unique = [...new Set(novelIds)].filter(Number.isSafeInteger);
  if (unique.length === 0) return 0;
  return invokeDbQuery<number>("db_novel_count_library_stored_chapters", {
    novelIds: unique,
    mode: readMode,
  });
}

export async function listLibrarySourceFilters(
  filter: Omit<LibraryFilter, "limit" | "sortOrder" | "sourceId"> = {},
  readMode: DatabaseReadMode = "queued",
): Promise<LibrarySourceFilter[]> {
  return invokeDbQuery<LibrarySourceFilter[]>(
    "db_novel_list_library_source_filters",
    {
      filter,
      mode: readMode,
    },
  );
}

export async function listLibraryNovelRefreshTargets(
  filter: LibraryNovelRefreshFilter = {},
): Promise<LibraryNovelRefreshTarget[]> {
  return invokeDbQuery<LibraryNovelRefreshTarget[]>(
    "db_novel_list_library_refresh_targets",
    {
      filter,
      mode: "queued",
    },
  );
}

/**
 * Full row shape used by the novel detail screen.
 */
export interface NovelDetailRecord {
  id: number;
  sourceNovelId: string | null;
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
  rating: number | null;
  inLibrary: boolean;
  isLocal: boolean;
  createdAt: number;
  updatedAt: number;
  libraryAddedAt: number | null;
  lastReadAt: number | null;
}

export async function getNovelById(
  id: number,
  readMode: DatabaseReadMode = "queued",
): Promise<NovelDetailRecord | null> {
  return invokeDbQuery<NovelDetailRecord | null>("db_novel_get_by_id", {
    id,
    mode: readMode,
  });
}

export async function findNovelBySource(
  pluginId: string,
  path: string,
): Promise<NovelDetailRecord | null> {
  return invokeDbQuery<NovelDetailRecord | null>("db_novel_find_by_source", {
    pluginId,
    path,
    mode: "queued",
  });
}

/**
 * Toggle a novel's library membership. Touches `updated_at` so
 * Library reorders the row on the next paint. Removal also clears the
 * novel's download goal.
 */
export async function setNovelInLibrary(
  id: number,
  inLibrary: boolean,
): Promise<void> {
  await invokeDbMutation("db_novel_set_in_library", { id, inLibrary });
}

export async function countNovels(): Promise<number> {
  return invokeDbQuery<number>("db_novel_count", { mode: "queued" });
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
  await invokeDbMutation("db_novel_insert_if_absent", {
    input: {
      pluginId: input.pluginId,
      path: input.path,
      name: input.name,
      cover: input.cover ?? null,
      inLibrary: input.inLibrary ?? true,
    },
  });
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

export async function renumberLocalNovelChapters(
  novelId: number,
): Promise<LocalChapterOrderMutationResult> {
  return invokeDbMutation<LocalChapterOrderMutationResult>(
    "db_novel_renumber_local_chapters",
    { novelId },
  );
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

export async function updateLocalNovelMetadata(
  novelId: number,
  input: LocalNovelMetadataInput,
): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new Error("local novel: name is required");
  await invokeDbMutation("db_novel_update_local_metadata", {
    novelId,
    input: {
      name,
      cover: input.cover ?? null,
      summary: input.summary ?? null,
      author: input.author ?? null,
      artist: input.artist ?? null,
      status: input.status ?? null,
      genres: input.genres ?? null,
    },
  });
}

export async function reorderLocalNovelChapters(
  novelId: number,
  chapterIds: number[],
): Promise<void> {
  await invokeDbMutation("db_novel_reorder_local_chapters", {
    novelId,
    chapterIds,
  });
}

export async function upsertLocalNovel(
  input: LocalNovelImportInput,
): Promise<LocalNovelImportResult> {
  return invokeDbMutation<LocalNovelImportResult>("db_novel_upsert_local", {
    input: {
      path: input.path,
      name: input.name,
      cover: input.cover ?? null,
      hasCover: input.cover !== undefined,
      summary: input.summary ?? null,
      hasSummary: input.summary !== undefined,
      author: input.author ?? null,
      hasAuthor: input.author !== undefined,
      artist: input.artist ?? null,
      hasArtist: input.artist !== undefined,
      status: input.status ?? null,
      hasStatus: input.status !== undefined,
      genres: input.genres ?? null,
      hasGenres: input.genres !== undefined,
      chapters: input.chapters.map((chapter) => ({
        path: chapter.path,
        name: chapter.name,
        position: chapter.position,
        contentType: normalizeChapterContentType(chapter.contentType),
        contentBytes: chapter.contentBytes,
        chapterNumber: chapter.chapterNumber ?? null,
        page: chapter.page ?? "1",
        releaseTime: chapter.releaseTime ?? null,
      })),
    },
  });
}
