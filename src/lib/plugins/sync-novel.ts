import { getDb, runDatabaseTransaction } from "../../db/client";
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
import { markUpdatesIndexDirty } from "../updates/update-index-events";
import type { ChapterItem, NovelItem, Plugin, SourceNovel } from "./types";

export interface SyncNovelFromSourceOptions {
  chapterRefreshMode?: "full" | "since";
  novelId?: number;
  notifyUpdatesIndex?: boolean;
  preserveMissingMetadata?: boolean;
}

export interface SyncNovelFromSourceResult {
  changed: boolean;
  changedChapters: number;
  novelId: number;
  chapterCount: number;
}

function optionalText(value: string | undefined | null): string | null {
  return value ?? null;
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
): ChapterItem[] {
  const seen = new Set<number>();
  for (const chapter of chapters) {
    const chapterNumber = chapter.chapterNumber;
    if (typeof chapterNumber !== "number" || !Number.isFinite(chapterNumber)) {
      throw new Error(
        `Plugin '${pluginId}' ${method} returned a chapter without a finite numeric chapterNumber.`,
      );
    }
    if (seen.has(chapterNumber)) {
      throw new Error(
        `Plugin '${pluginId}' ${method} returned duplicate chapterNumber ${chapterNumber}.`,
      );
    }
    pluginChapterContentType(chapter.contentType);
    seen.add(chapterNumber);
  }

  return [...chapters].sort((left, right) => {
    return left.chapterNumber - right.chapterNumber;
  });
}

function assertSourceNovel(
  pluginId: string,
  method: string,
  detail: SourceNovel,
): SourceNovel {
  if (!Array.isArray(detail.chapters)) {
    throw new Error(
      `Plugin '${pluginId}' ${method} did not return a chapter list.`,
    );
  }
  return {
    ...detail,
    chapters: assertSourceChapters(pluginId, method, detail.chapters),
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
): Promise<{ detail: SourceNovel; startPosition: number }> {
  return {
    detail: assertSourceNovel(
      plugin.id,
      "parseNovel",
      await plugin.parseNovel(path),
    ),
    startPosition: 1,
  };
}

async function parseNovelForSync(
  plugin: Plugin,
  item: NovelItem,
  options: SyncNovelFromSourceOptions,
): Promise<{ detail: SourceNovel; startPosition: number }> {
  if (options.chapterRefreshMode !== "since") {
    return parseFullNovel(plugin, item.path);
  }

  const existingNovelId =
    options.novelId ?? (await resolveExistingNovelId(plugin.id, item.path));
  if (!existingNovelId) {
    return parseFullNovel(plugin, item.path);
  }

  const anchor = await getLatestSourceChapterAnchor(existingNovelId);
  if (!anchor) {
    return parseFullNovel(plugin, item.path);
  }

  const sinceDetail = assertSourceNovel(
    plugin.id,
    "parseNovelSince",
    await plugin.parseNovelSince(item.path, anchor.chapterNumber),
  );
  const firstChapter = sinceDetail.chapters[0];
  if (!firstChapter) {
    return parseFullNovel(plugin, item.path);
  }
  if (firstChapter.chapterNumber < anchor.chapterNumber) {
    return { detail: sinceDetail, startPosition: 1 };
  }
  if (firstChapter.chapterNumber === anchor.chapterNumber) {
    return { detail: sinceDetail, startPosition: anchor.position };
  }

  return parseFullNovel(plugin, item.path);
}

export async function syncNovelFromSource(
  plugin: Plugin,
  item: NovelItem,
  options: SyncNovelFromSourceOptions = {},
): Promise<SyncNovelFromSourceResult> {
  const { detail, startPosition } = await parseNovelForSync(
    plugin,
    item,
    options,
  );
  const preserveMissingMetadata = options.preserveMissingMetadata ?? false;
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

  const result = await runDatabaseTransaction(async (db) => {
    const novelResult = await db.execute(
      `INSERT INTO novel (plugin_id, path, name, cover, summary, author, artist, status, genres)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(plugin_id, path) DO UPDATE SET
         name = excluded.name,
         ${metadataAssignment("cover", preserveMissingMetadata)},
         ${metadataAssignment("summary", preserveMissingMetadata)},
         ${metadataAssignment("author", preserveMissingMetadata)},
         ${metadataAssignment("artist", preserveMissingMetadata)},
         ${metadataAssignment("status", preserveMissingMetadata)},
         ${metadataAssignment("genres", preserveMissingMetadata)},
         updated_at = unixepoch()
        WHERE
          name IS NOT excluded.name
          OR ${metadataChangedClause("cover", preserveMissingMetadata)}
          OR ${metadataChangedClause("summary", preserveMissingMetadata)}
          OR ${metadataChangedClause("author", preserveMissingMetadata)}
          OR ${metadataChangedClause("artist", preserveMissingMetadata)}
          OR ${metadataChangedClause("status", preserveMissingMetadata)}
          OR ${metadataChangedClause("genres", preserveMissingMetadata)}`,
      [
        plugin.id,
        item.path,
        detail.name || item.name,
        optionalText(detail.cover) ?? optionalText(item.cover),
        optionalText(detail.summary),
        optionalText(detail.author),
        optionalText(detail.artist),
        detail.status ? String(detail.status) : null,
        optionalText(detail.genres),
      ],
    );

    const rows = await db.select<{ id: number }[]>(
      `SELECT id FROM novel WHERE plugin_id = $1 AND path = $2`,
      [plugin.id, item.path],
    );
    const novelId = rows[0]?.id;
    if (!novelId) {
      throw new Error("sync-novel: failed to resolve local novel id");
    }

    const chapterMutation = await upsertSourceChaptersInDb(
      db,
      chapterInputs.map((chapter) => ({
        ...chapter,
        novelId,
      })),
    );
    return {
      changedChapters: chapterMutation.rowsAffected,
      novelChanged: novelResult.rowsAffected > 0,
      novelId,
    };
  });

  const changed = result.novelChanged || result.changedChapters > 0;
  if (changed && (options.notifyUpdatesIndex ?? true)) {
    markUpdatesIndexDirty("novel-sync");
  }

  return {
    changed,
    changedChapters: result.changedChapters,
    novelId: result.novelId,
    chapterCount: detail.chapters.length,
  };
}
