import type { ChapterContentType } from "../../lib/chapter-content";
import {
  MAX_BACKFILL_PER_RUN,
  clampBackfillLimit,
} from "../../lib/performance-budgets";
import { invokeDbMutation, invokeDbQuery } from "../ipc";

export interface DownloadCacheResult {
  rowsAffected: number;
}

export interface DownloadCacheNovel {
  novelId: number;
  novelName: string;
  novelCover: string | null;
  novelPath: string;
  pluginId: string;
  sourceNovelId: string | null;
  pluginName?: string | null;
  inLibrary: boolean;
  chaptersDownloaded: number;
  totalChapters: number;
  unreadDownloaded: number;
  readDownloaded: number;
  mediaRepairNeededChapters: number;
  totalBytes: number;
  lastDownloadedAt: number | null;
}

export interface DownloadCacheChapter {
  id: number;
  novelId: number;
  name: string;
  position: number;
  unread: boolean;
  progress: number;
  readAt: number | null;
  downloadedAt: number | null;
  contentBytes: number;
  mediaBytes: number;
  mediaRepairNeeded: boolean;
  totalBytes: number;
}

export type DownloadCacheDeleteChapterIdFilter =
  | { chapterIds: readonly number[]; novelIds?: never }
  | { chapterIds?: never; novelIds: readonly number[] }
  | { chapterIds?: undefined; novelIds?: undefined };

export interface DownloadCacheDeleteChapterCandidate {
  contentBytes: number;
  id: number;
  isDownloaded: boolean;
  path: string;
  pluginId: string;
  sourceContentType: ChapterContentType;
}

export interface DownloadCacheMediaBackfillCandidate {
  id: number;
  sourceNovelId: string | null;
  chapterName: string;
  chapterNumber: string | null;
  novelId: number;
  novelName: string;
  novelPath: string;
  pluginId: string;
  position: number;
  updatedAt: number;
}

function normalizeTargetIds(
  rawIds: readonly number[] | undefined,
): number[] | undefined {
  if (rawIds === undefined) return undefined;
  return [
    ...new Set(rawIds.filter((id) => Number.isInteger(id) && id > 0)),
  ].sort((left, right) => left - right);
}

export async function listDownloadCacheNovels(): Promise<DownloadCacheNovel[]> {
  return invokeDbQuery<DownloadCacheNovel[]>("db_download_cache_list_novels");
}

export async function listDownloadCacheChapters(
  novelId: number,
): Promise<DownloadCacheChapter[]> {
  return invokeDbQuery<DownloadCacheChapter[]>(
    "db_download_cache_list_chapters",
    { novelId },
  );
}

export async function listNonLocalDownloadCacheDeleteChapters(
  filter: DownloadCacheDeleteChapterIdFilter = {},
): Promise<DownloadCacheDeleteChapterCandidate[]> {
  const chapterIds = normalizeTargetIds(filter.chapterIds);
  const novelIds = normalizeTargetIds(filter.novelIds);
  if (chapterIds?.length === 0 || novelIds?.length === 0) {
    return [];
  }
  return invokeDbQuery<DownloadCacheDeleteChapterCandidate[]>(
    "db_download_cache_list_delete_candidates",
    {
      filter:
        chapterIds !== undefined
          ? { chapterIds }
          : novelIds !== undefined
            ? { novelIds }
            : {},
    },
  );
}

export async function listNonLocalOrdinaryQueuedDownloadChapterIds(
  filter: DownloadCacheDeleteChapterIdFilter = {},
): Promise<number[]> {
  const chapterIds = normalizeTargetIds(filter.chapterIds);
  const novelIds = normalizeTargetIds(filter.novelIds);
  if (chapterIds?.length === 0 || novelIds?.length === 0) {
    return [];
  }
  return invokeDbQuery<number[]>(
    "db_download_cache_list_ordinary_queued_ids",
    {
      filter:
        chapterIds !== undefined
          ? { chapterIds }
          : novelIds !== undefined
            ? { novelIds }
            : {},
    },
  );
}

export async function deleteDownloadCacheChapter(
  chapterId: number,
): Promise<DownloadCacheResult> {
  return invokeDbMutation<DownloadCacheResult>(
    "db_download_cache_delete_chapter",
    { chapterId },
  );
}

export async function deleteDownloadCacheNovel(
  novelId: number,
): Promise<DownloadCacheResult> {
  return invokeDbMutation<DownloadCacheResult>(
    "db_download_cache_delete_novel",
    { novelId },
  );
}

export async function deleteAllDownloadCache(): Promise<DownloadCacheResult> {
  return invokeDbMutation<DownloadCacheResult>("db_download_cache_delete_all");
}

export async function listDownloadCacheMediaBackfillCandidates(
  novelId?: number,
  limit: number = MAX_BACKFILL_PER_RUN,
): Promise<DownloadCacheMediaBackfillCandidate[]> {
  return invokeDbQuery<DownloadCacheMediaBackfillCandidate[]>(
    "db_download_cache_list_media_backfill_candidates",
    {
      novelId: novelId ?? null,
      limit: clampBackfillLimit(limit),
    },
  );
}

export async function updateDownloadCacheChapterMediaBytes(
  chapterId: number,
  mediaBytes: number,
): Promise<DownloadCacheResult> {
  return invokeDbMutation<DownloadCacheResult>(
    "db_download_cache_update_media_bytes",
    {
      chapterId,
      mediaBytes: Math.max(0, Math.round(mediaBytes)),
    },
  );
}
