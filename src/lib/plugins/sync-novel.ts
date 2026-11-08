import { getDb, runDatabaseTransaction } from "../../db/client";
import { getChapterComposition, materializeChapterComposition, setChapterComposition } from "../../db/chapter-composition";
import { compositionSourceAnchor, refreshChapterComposition } from "../chapter-composition-refresh";
import { flushWorkMetadata, knownNovelMetadataDirectory, markWorkMetadataRefreshed } from "../../db/work-metadata";
import { sqliteBoolean } from "../../db/sqlite-value";
import { reconcileImportedNovelIdentityInDb } from "../../db/queries/novel-identity";
import {
  getLatestSourceChapterAnchor,
  upsertSourceChaptersInDb,
  type InsertChapterInput,
} from "../../db/queries/chapter";
import {
  DEFAULT_CHAPTER_CONTENT_TYPE,
  isKnownChapterContentType,
  type ChapterContentType,
} from "../chapter-content";
import { recordNovelCoverFetched } from "../../db/queries/novel-freshness";
import { saveNovelCoverFromSource } from "../novel-cover-storage";
import { markUpdatesIndexDirty } from "../updates/update-index-events";
import { normalizeSourceAccessRequiredError } from "./source-access";
import { notifyWorkMetadataChanges, readStoredNovelMetadata } from "../work-metadata";
import { isTauriRuntime } from "../tauri-runtime";
import { isStorageId } from "../storage-id";
import type { ChapterItem, NovelItem, Plugin, SourceNovel } from "./types";
import type { NovelMetadataV1 } from "../work-metadata/schema";
import { withSourceChapterNumberReconciliation } from "./source-chapter-renumber";
import { applySourceChapterNumberChangesInDb, commitSourceChapterRenumberInDb, planSourceChapterNumberChanges, readRenumberChapters, type SourceChapterRenumberJournal } from "../source-chapter-renumber";

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
  authoritativeMetadata?: Pick<NovelMetadataV1, "identity" | "novel"> & { coverUrl: string | null };
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

/** A cover whose source value is unchanged is fetched again at most this often. */
export const COVER_REFRESH_SECONDS = 30 * 24 * 60 * 60;

const sourceDuplicateChaptersByNovelId = new Map<
  number,
  SourceDuplicateChapterInfo[]
>();
const sourceRefreshes = new Map<string, {
  generation: number;
  fullGeneration: number;
  pending: number;
  latest: Promise<SyncNovelFromSourceResult> | null;
  latestFull: Promise<SyncNovelFromSourceResult> | null;
}>();

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
    throw new Error(`sync-novel: unsupported chapter contentType "${String(value)}".`);
  }
  return value;
}

function metadataAssignment(
  column: string,
  preserveMissingMetadata: boolean,
): string {
  return `${column} = ${metadataValue(column, preserveMissingMetadata)}`;
}

function metadataChangedClause(
  column: string,
  preserveMissingMetadata: boolean,
): string {
  return `${column} IS NOT ${metadataValue(column, preserveMissingMetadata)}`;
}

function metadataValue(
  column: string,
  preserveMissingMetadata: boolean,
): string {
  return preserveMissingMetadata
    ? `COALESCE(excluded.${column}, ${column})`
    : `excluded.${column}`;
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
    if (typeof chapterNumber !== "number" || !Number.isFinite(chapterNumber) || !/^\d+(?:\.\d+)?$/.test(String(chapterNumber))) {
      throw new Error(
        `Plugin '${pluginId}' ${method} returned a chapter without a finite numeric chapterNumber.`,
      );
    }

    if (chapter.sourceChapterId !== undefined && (typeof chapter.sourceChapterId !== "string" || !chapter.sourceChapterId.trim())) {
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
  if (!isStorageId(detail.novelId)) throw new Error(`Plugin '${pluginId}' ${method} returned an invalid novel ID.`);
  if (detail.rating !== undefined && (
    !Number.isFinite(detail.rating) || detail.rating < 0 || detail.rating > 5
  )) {
    throw new Error(`Plugin '${pluginId}' ${method} returned a rating outside 0 to 5.`);
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

async function resolveExistingNovelId(
  pluginId: string,
  path: string,
): Promise<number | null> {
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(
    `SELECT id FROM novel WHERE plugin_id = $1 AND path = $2`,
    [pluginId, path],
  );
  return rows[0]?.id ?? null;
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

  const existingNovelId =
    options.novelId ?? (await resolveExistingNovelId(plugin.id, item.path));
  if (!existingNovelId) {
    return parseFullNovel(plugin, item.path, options.signal);
  }

  if (isTauriRuntime()) {
    const directory = knownNovelMetadataDirectory({ pluginId: plugin.id, novelPath: item.path });
    const stored = directory ? await readStoredNovelMetadata(directory) : null;
    if (!stored || !Object.keys(stored.metadata.chapters).length) return parseFullNovel(plugin, item.path, options.signal);
  }

  const db = await getDb();
  const composition = await getChapterComposition(db, existingNovelId);
  const [storedIdentity] = composition ? await db.select<{ sourceNovelId: string }[]>(
    "SELECT source_novel_id AS sourceNovelId FROM novel WHERE id=$1", [existingNovelId],
  ) : [];
  const anchor = composition && storedIdentity
    ? compositionSourceAnchor(composition, { pluginId: plugin.id, novelId: storedIdentity.sourceNovelId })
    : await getLatestSourceChapterAnchor(existingNovelId);
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
    return { ...sinceResult, startPosition: anchor.position, fullCatalog: false };
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
  const state = sourceRefreshes.get(key) ?? { generation: 0, fullGeneration: 0, pending: 0, latest: null, latestFull: null };
  const generation = ++state.generation;
  const full = options.chapterRefreshMode !== "since";
  if (full) state.fullGeneration = generation;
  state.pending++;
  sourceRefreshes.set(key, state);
  // A later check for new chapters covers only the newest chapters, so it supersedes an earlier
  // check but never a full refresh, which alone rewrites every chapter and refetches the cover.
  const isCurrent = full ? () => state.fullGeneration === generation : () => state.generation === generation;
  const promise: Promise<SyncNovelFromSourceResult> = performNovelSourceRefresh(
    plugin, item, options, isCurrent,
  ).then(result => result ?? (full ? state.latestFull! : state.latest!));
  state.latest = promise;
  if (full) state.latestFull = promise;
  try { return await promise; }
  finally { if (--state.pending === 0) sourceRefreshes.delete(key); }
}

async function performNovelSourceRefresh(
  plugin: Plugin,
  item: NovelItem,
  options: SyncNovelFromSourceOptions,
  isCurrent: () => boolean,
): Promise<SyncNovelFromSourceResult | null> {
  options.signal?.throwIfAborted();
  const { detail, duplicateChapters, startPosition, fullCatalog } = await parseNovelForSync(
    plugin,
    item,
    options,
  );
  options.signal?.throwIfAborted();
  if (!isCurrent()) return null;
  const preserveMissingMetadata = options.preserveMissingMetadata ?? true;
  const cover = optionalText(detail.cover) ?? (preserveMissingMetadata ? optionalText(item.cover) : null);
  const novelName = preserveMissingMetadata ? detail.name || item.name : detail.name;
  if (!optionalText(novelName)) throw new Error(`Plugin '${plugin.id}' returned an empty novel name.`);
  const authoritativeMetadata: SyncNovelFromSourceResult["authoritativeMetadata"] = !preserveMissingMetadata ? {
    identity: { pluginId: plugin.id, novelId: detail.novelId, novelPath: item.path },
    novel: { name: novelName, author: optionalText(detail.author), artist: optionalText(detail.artist),
      summary: optionalText(detail.summary), status: optionalText(detail.status == null ? null : String(detail.status)),
      genres: optionalText(detail.genres), rating: detail.rating ?? null, isLocal: false },
    coverUrl: cover,
  } : undefined;
  const chapterInputs: InsertChapterInput[] = detail.chapters.map(
    (chapter, index) => ({
      novelId: 0,
      path: chapter.path,
      name: chapter.name,
      position: startPosition + index,
      chapterNumber: String(chapter.chapterNumber),
      page: chapter.page ?? "1",
      releaseTime: chapter.releaseTime ?? null,
      contentType: pluginChapterContentType(chapter.contentType),
    }),
  );

  const publish = (renumber: SourceChapterRenumberJournal | null) => runDatabaseTransaction(async (db) => {
    options.signal?.throwIfAborted();
    if (!isCurrent()) return null;
    if (options.novelId !== undefined) {
      const [current] = await db.select<{ id: number }[]>(
        "SELECT id FROM novel WHERE id=$1 AND plugin_id=$2 AND path=$3",
        [options.novelId, plugin.id, item.path],
      );
      if (!current) throw new Error("Work no longer matches the source refresh; open it again before refreshing.");
    }
    const reconciled = await reconcileImportedNovelIdentityInDb(db, {
      pluginId: plugin.id, path: item.path, name: item.name,
    }, chapterInputs);
    options.signal?.throwIfAborted();
    const [storedIdentity] = await db.select<
      { sourceNovelId: string | null; previousCover?: string | null; coverFetchedAt?: number | null }[]
    >(
      `SELECT n.source_novel_id AS sourceNovelId, n.cover AS previousCover, f.cover_fetched_at AS coverFetchedAt
       FROM novel n LEFT JOIN novel_freshness f ON f.novel_id = n.id WHERE n.plugin_id=$1 AND n.path=$2`,
      [plugin.id, item.path]);
    if (storedIdentity?.sourceNovelId && storedIdentity.sourceNovelId !== detail.novelId) {
      throw new Error(`Plugin '${plugin.id}' changed a stored novel ID.`);
    }
    const novelResult = await db.execute(
      `INSERT INTO novel (plugin_id, path, name, cover, summary, author, artist, status, genres, rating, source_novel_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT(plugin_id, path) DO UPDATE SET
         name = excluded.name,
         source_novel_id = excluded.source_novel_id,
         ${metadataAssignment("cover", preserveMissingMetadata)},
         ${metadataAssignment("summary", preserveMissingMetadata)},
         ${metadataAssignment("author", preserveMissingMetadata)},
         ${metadataAssignment("artist", preserveMissingMetadata)},
         ${metadataAssignment("status", preserveMissingMetadata)},
         ${metadataAssignment("genres", preserveMissingMetadata)},
         ${metadataAssignment("rating", preserveMissingMetadata)},
         updated_at = unixepoch()
        WHERE
          source_novel_id IS NOT excluded.source_novel_id
          OR name IS NOT excluded.name
          OR ${metadataChangedClause("cover", preserveMissingMetadata)}
          OR ${metadataChangedClause("summary", preserveMissingMetadata)}
          OR ${metadataChangedClause("author", preserveMissingMetadata)}
          OR ${metadataChangedClause("artist", preserveMissingMetadata)}
          OR ${metadataChangedClause("status", preserveMissingMetadata)}
          OR ${metadataChangedClause("genres", preserveMissingMetadata)}
          OR ${metadataChangedClause("rating", preserveMissingMetadata)}`,
      [
        plugin.id,
        item.path,
        novelName,
        cover,
        optionalText(detail.summary),
        optionalText(detail.author),
        optionalText(detail.artist),
        optionalText(detail.status == null ? null : String(detail.status)),
        optionalText(detail.genres),
        detail.rating ?? null,
        detail.novelId,
      ],
    );

    const rows = await db.select<
      { cover: string | null; id: number; inLibrary: unknown }[]
    >(
      `SELECT id, cover, in_library AS inLibrary
       FROM novel
       WHERE plugin_id = $1 AND path = $2`,
      [plugin.id, item.path],
    );
    const novelRow = rows[0];
    if (!novelRow?.id) {
      throw new Error("sync-novel: failed to resolve local novel id");
    }
    const novelId = novelRow.id;
    const [before] = options.markFoundByCheck
      ? await db.select<{ chapters: number; maxId: number }[]>(
        `SELECT (SELECT COUNT(*) FROM chapter WHERE novel_id = $1) AS chapters,
                (SELECT COALESCE(MAX(id), 0) FROM chapter) AS maxId`, [novelId])
      : [];

    const composition = await getChapterComposition(db, novelId);
    let chapterMutation: { rowsAffected: number };
    if (composition) {
      if (renumber) throw new Error("A composed chapter list cannot be renumbered by a provider refresh.");
      const updated = refreshChapterComposition(composition,
        { pluginId: plugin.id, novelId: detail.novelId, novelPath: item.path }, detail.chapters, { startPosition });
      const changedEntries = updated.entries.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(composition.entries[index])).length;
      await materializeChapterComposition(db, novelId, updated);
      await setChapterComposition(db, novelId, updated);
      chapterMutation = { rowsAffected: changedEntries };
    } else {
    if (renumber) {
      await applySourceChapterNumberChangesInDb(db, novelId, renumber);
    } else if (planSourceChapterNumberChanges(
      { id: novelId, pluginId: plugin.id, sourceNovelId: detail.novelId, path: item.path },
      await readRenumberChapters(db, novelId), detail.chapters,
    ).length) {
      throw new Error("Chapter numbers changed during refresh. Refresh the complete chapter list again.");
    }
    chapterMutation = await upsertSourceChaptersInDb(
      db,
      chapterInputs.map((chapter) => ({
        ...chapter,
        novelId,
      })),
    );
    }
    // Chapter ids only grow, so rows above the previous maximum are the ones this check inserted.
    const newChapters = before && before.chapters > 0
      ? (await db.execute("UPDATE chapter SET found_by_check = 1 WHERE novel_id = $1 AND id > $2",
        [novelId, before.maxId])).rowsAffected
      : 0;
    if (composition) await flushWorkMetadata(db);
    else await flushWorkMetadata(db, {
      novelId, chapters: Object.fromEntries(detail.chapters.map(chapter => [String(chapter.chapterNumber), chapter.name])),
      ...(renumber ? { replacedChapterNumbers: renumber.changes.map(change => change.chapterNumber) } : {}),
    });
    const stored = novelResult.rowsAffected > 0 || (reconciled?.changed ?? false) || chapterMutation.rowsAffected > 0;
    // A check that changed nothing leaves the content-server upload revision alone; other refreshes
    // still republish the retained details, which can repair a conflicting work file.
    const republish = stored || !options.markFoundByCheck;
    if (republish) await markWorkMetadataRefreshed(db, { pluginId: plugin.id, novelPath: item.path });
    if (renumber) await commitSourceChapterRenumberInDb(db, renumber);
    return {
      republish,
      changedChapters: chapterMutation.rowsAffected,
      newChapters,
      cover: preserveMissingMetadata ? optionalText(novelRow.cover) ?? cover : cover,
      coverChanged: optionalText(storedIdentity?.previousCover) !== null &&
        optionalText(storedIdentity?.previousCover) !== optionalText(novelRow.cover),
      coverFetchedAt: storedIdentity?.coverFetchedAt ?? null,
      novelChanged: novelResult.rowsAffected > 0 || (reconciled?.changed ?? false),
      inLibrary: sqliteBoolean(novelRow.inLibrary),
      novelId,
    };
  });
  const result = await withSourceChapterNumberReconciliation({
      pluginId: plugin.id, path: item.path, sourceNovelId: detail.novelId,
      chapters: detail.chapters, fullCatalog, isCurrent, signal: options.signal,
    }, publish);
  if (!result) return null;
  if (result.republish) notifyWorkMetadataChanges({ pluginId: plugin.id, novelPath: item.path });

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
    const refresh = options.refreshCover === true || !preserveMissingMetadata || result.coverChanged ||
      (result.coverFetchedAt !== null && nowSeconds - result.coverFetchedAt >= COVER_REFRESH_SECONDS);
    try {
      await saveNovelCoverFromSource(
        plugin,
        {
          id: result.novelId,
          name: novelName,
          path: item.path,
          pluginId: plugin.id,
        },
        result.cover,
        { refresh, ...(!preserveMissingMetadata ? { clearMissing: true } : {}) },
      );
      if (refresh || result.coverFetchedAt === null) await recordNovelCoverFetched(result.novelId, nowSeconds);
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
