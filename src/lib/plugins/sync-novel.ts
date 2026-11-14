import { invokeDbMutation, invokeDbQuery } from "../../db/ipc";
import type { LatestSourceChapterAnchor } from "../../db/queries/chapter";
import { recordNovelCoverFetched } from "../../db/queries/novel-freshness";
import { knownNovelMetadataDirectory } from "../../db/work-metadata";
import {
  DEFAULT_CHAPTER_CONTENT_TYPE,
  isKnownChapterContentType,
  type ChapterContentType,
} from "../chapter-content";
import { saveNovelCoverFromSource } from "../novel-cover-storage";
import type { SourceChapterRenumberJournal } from "../source-chapter-renumber";
import { isStorageId } from "../storage-id";
import { isTauriRuntime } from "../tauri-runtime";
import { markUpdatesIndexDirty } from "../updates/update-index-events";
import {
  notifyWorkMetadataChanges,
  readStoredNovelMetadata,
} from "../work-metadata";
import type { NovelMetadataV1 } from "../work-metadata/schema";
import { normalizeSourceAccessRequiredError } from "./source-access";
import { withSourceChapterNumberReconciliation } from "./source-chapter-renumber";
import type { ChapterItem, NovelItem, Plugin, SourceNovel } from "./types";

export interface SyncNovelFromSourceOptions {
  signal?: AbortSignal;
  chapterRefreshMode?: "full" | "since";
  novelId?: number;
  notifyUpdatesIndex?: boolean;
  preserveMissingMetadata?: boolean;
  refreshCover?: boolean;
  /**
   * A check for new chapters: chapters it inserts into a novel that already had chapters
   * are flagged as found by a check, which the Updates list shows.
   */
  markFoundByCheck?: boolean;
}

export interface SourceDuplicateChapterInfo {
  chapterNumber: number;
  keptName: string;
  keptPath: string;
  discardedCount: number;
}

export interface SyncNovelFromSourceResult {
  changed: boolean;
  changedChapters: number;
  /** Chapters this check flagged as found by a check; zero unless `markFoundByCheck` was set. */
  newChapters: number;
  novelId: number;
  chapterCount: number;
  duplicateChapters: SourceDuplicateChapterInfo[];
  authoritativeMetadata?: Pick<NovelMetadataV1, "identity" | "novel"> & {
    coverUrl: string | null;
  };
}

interface SourceChapterListResult {
  chapters: ChapterItem[];
  duplicateChapters: SourceDuplicateChapterInfo[];
}

interface ParsedSourceNovelResult {
  detail: SourceNovel;
  duplicateChapters: SourceDuplicateChapterInfo[];
  startPosition: number;
  fullCatalog: boolean;
}

interface SyncSinceAnchorResponse {
  existingNovelId: number;
  anchor: LatestSourceChapterAnchor | null;
}

interface SyncNovelPublishResult {
  republish: boolean;
  changedChapters: number;
  newChapters: number;
  cover: string | null;
  coverChanged: boolean;
  coverFetchedAt: number | null;
  novelChanged: boolean;
  inLibrary: boolean;
  novelId: number;
}

/** A cover whose source value is unchanged is fetched again at most this often. */
export const COVER_REFRESH_SECONDS = 30 * 24 * 60 * 60;

const sourceDuplicateChaptersByNovelId = new Map<
  number,
  SourceDuplicateChapterInfo[]
>();
const sourceRefreshes = new Map<
  string,
  {
    generation: number;
    fullGeneration: number;
    pending: number;
    latest: Promise<SyncNovelFromSourceResult> | null;
    latestFull: Promise<SyncNovelFromSourceResult> | null;
  }
>();

export function getSourceDuplicateChapterInfo(
  novelId: number,
): readonly SourceDuplicateChapterInfo[] {
  return sourceDuplicateChaptersByNovelId.get(novelId) ?? [];
}

function rememberSourceDuplicateChapters(
  novelId: number,
  duplicateChapters: SourceDuplicateChapterInfo[],
): void {
  if (duplicateChapters.length === 0) {
    sourceDuplicateChaptersByNovelId.delete(novelId);
    return;
  }
  sourceDuplicateChaptersByNovelId.set(novelId, duplicateChapters);
}

function optionalText(value: string | undefined | null): string | null {
  return value?.trim() ? value : null;
}

function pluginChapterContentType(value: unknown): ChapterContentType {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_CHAPTER_CONTENT_TYPE;
  }
  if (!isKnownChapterContentType(value)) {
    throw new Error(
      `sync-novel: unsupported chapter contentType "${String(value)}".`,
    );
  }
  return value;
}

function assertSourceChapters(
  pluginId: string,
  method: string,
  chapters: readonly ChapterItem[],
): SourceChapterListResult {
  const firstByChapterNumber = new Map<number, ChapterItem>();
  const duplicateChapters = new Map<number, SourceDuplicateChapterInfo>();

  for (const chapter of chapters) {
    const chapterNumber = chapter.chapterNumber;
    if (
      typeof chapterNumber !== "number" ||
      !Number.isFinite(chapterNumber) ||
      !/^\d+(?:\.\d+)?$/.test(String(chapterNumber))
    ) {
      throw new Error(
        `Plugin '${pluginId}' ${method} returned a chapter without a finite numeric chapterNumber.`,
      );
    }

    if (
      chapter.sourceChapterId !== undefined &&
      (typeof chapter.sourceChapterId !== "string" ||
        !chapter.sourceChapterId.trim())
    ) {
      throw new Error("Plugin returned an invalid sourceChapterId.");
    }
    pluginChapterContentType(chapter.contentType);

    const keptChapter = firstByChapterNumber.get(chapterNumber);
    if (keptChapter) {
      const duplicate = duplicateChapters.get(chapterNumber) ?? {
        chapterNumber,
        keptName: keptChapter.name,
        keptPath: keptChapter.path,
        discardedCount: 0,
      };
      duplicate.discardedCount += 1;
      duplicateChapters.set(chapterNumber, duplicate);
      continue;
    }

    firstByChapterNumber.set(chapterNumber, chapter);
  }

  return {
    chapters: [...firstByChapterNumber.values()].sort((left, right) => {
      return left.chapterNumber - right.chapterNumber;
    }),
    duplicateChapters: [...duplicateChapters.values()].sort((left, right) => {
      return left.chapterNumber - right.chapterNumber;
    }),
  };
}

function assertSourceNovel(
  pluginId: string,
  method: string,
  detail: SourceNovel,
): { detail: SourceNovel; duplicateChapters: SourceDuplicateChapterInfo[] } {
  if (!isStorageId(detail.novelId)) {
    throw new Error(
      `Plugin '${pluginId}' ${method} returned an invalid novel ID.`,
    );
  }
  if (
    detail.rating !== undefined &&
    (!Number.isFinite(detail.rating) || detail.rating < 0 || detail.rating > 5)
  ) {
    throw new Error(
      `Plugin '${pluginId}' ${method} returned a rating outside 0 to 5.`,
    );
  }
  if (!Array.isArray(detail.chapters)) {
    throw new Error(
      `Plugin '${pluginId}' ${method} did not return a chapter list.`,
    );
  }

  const chapterList = assertSourceChapters(pluginId, method, detail.chapters);
  return {
    detail: {
      ...detail,
      chapters: chapterList.chapters,
    },
    duplicateChapters: chapterList.duplicateChapters,
  };
}

async function parseFullNovel(
  plugin: Plugin,
  path: string,
  signal?: AbortSignal,
): Promise<ParsedSourceNovelResult> {
  signal?.throwIfAborted();
  const parsed = assertSourceNovel(
    plugin.id,
    "parseNovel",
    await plugin.parseNovel(path),
  );
  return {
    ...parsed,
    startPosition: 1,
    fullCatalog: true,
  };
}

async function parseNovelForSync(
  plugin: Plugin,
  item: NovelItem,
  options: SyncNovelFromSourceOptions,
): Promise<ParsedSourceNovelResult> {
  if (options.chapterRefreshMode !== "since") {
    return parseFullNovel(plugin, item.path, options.signal);
  }

  const sinceAnchor = await invokeDbQuery<SyncSinceAnchorResponse | null>(
    "db_chapter_get_sync_since_anchor",
    {
      pluginId: plugin.id,
      path: item.path,
      ...(options.novelId !== undefined ? { novelId: options.novelId } : {}),
    },
  );
  if (!sinceAnchor) {
    return parseFullNovel(plugin, item.path, options.signal);
  }

  if (isTauriRuntime()) {
    const directory = knownNovelMetadataDirectory({
      pluginId: plugin.id,
      novelPath: item.path,
    });
    const stored = directory ? await readStoredNovelMetadata(directory) : null;
    if (!stored || !Object.keys(stored.metadata.chapters).length) {
      return parseFullNovel(plugin, item.path, options.signal);
    }
  }

  const { anchor } = sinceAnchor;
  if (!anchor) {
    return parseFullNovel(plugin, item.path, options.signal);
  }

  options.signal?.throwIfAborted();
  const sinceResult = assertSourceNovel(
    plugin.id,
    "parseNovelSince",
    await plugin.parseNovelSince(item.path, anchor.chapterNumber),
  );
  const firstChapter = sinceResult.detail.chapters[0];
  if (!firstChapter) {
    return parseFullNovel(plugin, item.path, options.signal);
  }
  if (firstChapter.chapterNumber < anchor.chapterNumber) {
    return { ...sinceResult, startPosition: 1, fullCatalog: true };
  }
  if (firstChapter.chapterNumber === anchor.chapterNumber) {
    return {
      ...sinceResult,
      startPosition: anchor.position,
      fullCatalog: false,
    };
  }

  return parseFullNovel(plugin, item.path, options.signal);
}

export async function syncNovelFromSource(
  plugin: Plugin,
  item: NovelItem,
  options: SyncNovelFromSourceOptions = {},
): Promise<SyncNovelFromSourceResult> {
  options.signal?.throwIfAborted();
  const key = JSON.stringify([plugin.id, item.path]);
  const state = sourceRefreshes.get(key) ?? {
    generation: 0,
    fullGeneration: 0,
    pending: 0,
    latest: null,
    latestFull: null,
  };
  const generation = ++state.generation;
  const full = options.chapterRefreshMode !== "since";
  if (full) state.fullGeneration = generation;
  state.pending++;
  sourceRefreshes.set(key, state);
  // A later check for new chapters covers only the newest chapters, so it supersedes an earlier
  // check but never a full refresh, which alone rewrites every chapter and refetches the cover.
  const isCurrent = full
    ? () => state.fullGeneration === generation
    : () => state.generation === generation;
  const promise: Promise<SyncNovelFromSourceResult> = performNovelSourceRefresh(
    plugin,
    item,
    options,
    isCurrent,
  ).then((result) => result ?? (full ? state.latestFull! : state.latest!));
  state.latest = promise;
  if (full) state.latestFull = promise;
  try {
    return await promise;
  } finally {
    if (--state.pending === 0) sourceRefreshes.delete(key);
  }
}

async function performNovelSourceRefresh(
  plugin: Plugin,
  item: NovelItem,
  options: SyncNovelFromSourceOptions,
  isCurrent: () => boolean,
): Promise<SyncNovelFromSourceResult | null> {
  options.signal?.throwIfAborted();
  const { detail, duplicateChapters, startPosition, fullCatalog } =
    await parseNovelForSync(plugin, item, options);
  options.signal?.throwIfAborted();
  if (!isCurrent()) return null;
  const preserveMissingMetadata = options.preserveMissingMetadata ?? true;
  const cover =
    optionalText(detail.cover) ??
    (preserveMissingMetadata ? optionalText(item.cover) : null);
  const novelName = preserveMissingMetadata
    ? detail.name || item.name
    : detail.name;
  if (!optionalText(novelName)) {
    throw new Error(`Plugin '${plugin.id}' returned an empty novel name.`);
  }
  const authoritativeMetadata: SyncNovelFromSourceResult["authoritativeMetadata"] =
    !preserveMissingMetadata
      ? {
          identity: {
            pluginId: plugin.id,
            novelId: detail.novelId,
            novelPath: item.path,
          },
          novel: {
            name: novelName,
            author: optionalText(detail.author),
            artist: optionalText(detail.artist),
            summary: optionalText(detail.summary),
            status: optionalText(
              detail.status == null ? null : String(detail.status),
            ),
            genres: optionalText(detail.genres),
            rating: detail.rating ?? null,
            isLocal: false,
          },
          coverUrl: cover,
        }
      : undefined;

  const publish = async (renumber: SourceChapterRenumberJournal | null) => {
    options.signal?.throwIfAborted();
    if (!isCurrent()) return null;
    return invokeDbMutation<SyncNovelPublishResult>(
      "db_novel_sync_from_source",
      {
        input: {
          pluginId: plugin.id,
          novelPath: item.path,
          itemName: item.name,
          novelName,
          sourceNovelId: detail.novelId,
          cover,
          summary: optionalText(detail.summary),
          author: optionalText(detail.author),
          artist: optionalText(detail.artist),
          status: optionalText(
            detail.status == null ? null : String(detail.status),
          ),
          genres: optionalText(detail.genres),
          rating: detail.rating ?? null,
          preserveMissingMetadata,
          markFoundByCheck: options.markFoundByCheck ?? false,
          startPosition,
          ...(options.novelId !== undefined
            ? { expectedNovelId: options.novelId }
            : {}),
          chapters: detail.chapters.map((chapter) => ({
            path: chapter.path,
            name: chapter.name,
            chapterNumber: chapter.chapterNumber,
            ...(chapter.sourceChapterId !== undefined
              ? { sourceChapterId: chapter.sourceChapterId }
              : {}),
            page: chapter.page ?? "1",
            releaseTime: chapter.releaseTime ?? null,
            contentType: pluginChapterContentType(chapter.contentType),
          })),
          renumber,
        },
      },
    );
  };

  const result = await withSourceChapterNumberReconciliation(
    {
      pluginId: plugin.id,
      path: item.path,
      sourceNovelId: detail.novelId,
      chapters: detail.chapters,
      fullCatalog,
      isCurrent,
      signal: options.signal,
    },
    publish,
  );
  if (!result) return null;
  if (result.republish) {
    notifyWorkMetadataChanges({ pluginId: plugin.id, novelPath: item.path });
  }

  rememberSourceDuplicateChapters(result.novelId, duplicateChapters);

  const changed = result.novelChanged || result.changedChapters > 0;
  const superseded = !isCurrent();
  if (changed && ((options.notifyUpdatesIndex ?? true) || superseded)) {
    markUpdatesIndexDirty("novel-sync");
  }
  if (superseded) return null;

  if (result.inLibrary || options.refreshCover || !preserveMissingMetadata) {
    // Covers are fetched again when the source value changes, on an explicit rebuild, or after
    // 30 days for an unchanged value, since sites sometimes replace the image behind a URL.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const refresh =
      options.refreshCover === true ||
      !preserveMissingMetadata ||
      result.coverChanged ||
      (result.coverFetchedAt !== null &&
        nowSeconds - result.coverFetchedAt >= COVER_REFRESH_SECONDS);
    try {
      await saveNovelCoverFromSource(
        plugin,
        {
          id: result.novelId,
          name: novelName,
          path: item.path,
          pluginId: plugin.id,
          sourceNovelId: detail.novelId,
        },
        result.cover,
        {
          refresh,
          ...(!preserveMissingMetadata ? { clearMissing: true } : {}),
        },
      );
      if (refresh || result.coverFetchedAt === null) {
        await recordNovelCoverFetched(result.novelId, nowSeconds);
      }
    } catch (error) {
      const sourceAccessError = normalizeSourceAccessRequiredError(error);
      if (sourceAccessError) throw sourceAccessError;
      if (!preserveMissingMetadata) throw error;
      console.warn("[sync-novel] failed to store novel cover", {
        error,
        novelId: result.novelId,
        pluginId: plugin.id,
      });
    }
  }

  return {
    changed,
    changedChapters: result.changedChapters,
    newChapters: result.newChapters,
    novelId: result.novelId,
    chapterCount: detail.chapters.length,
    duplicateChapters,
    ...(authoritativeMetadata ? { authoritativeMetadata } : {}),
  };
}
