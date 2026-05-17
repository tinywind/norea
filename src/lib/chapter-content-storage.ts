import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../db/client";
import {
  deleteAndroidStoragePath,
  readAndroidStorageText,
  writeAndroidStorageText,
} from "./android-storage";
import {
  DEFAULT_CHAPTER_CONTENT_TYPE,
  normalizeChapterContentType,
} from "./chapter-content";
import { getStoredChapterMediaBytes } from "./chapter-media";
import { chapterMediaRepairFlag } from "./chapter-media-state";
import {
  chapterContentRelativePath as buildChapterContentRelativePath,
  type ChapterStorageChapterPathInput,
  type ChapterStorageNovelPathInput,
} from "./chapter-storage-path";
import { clampBackfillLimit } from "./performance-budgets";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

interface ChapterStorageRow {
  artist: string | null;
  author: string | null;
  bookmark: unknown;
  chapterCreatedAt: number | null;
  chapterFoundAt: number;
  chapterId: number;
  chapterName: string;
  chapterNumber: string | null;
  chapterPath: string;
  chapterUpdatedAt: number;
  content: string | null;
  contentBytes: number;
  contentType: string;
  cover: string | null;
  genres: string | null;
  inLibrary: unknown;
  isLocal: unknown;
  lastReadAt: number | null;
  libraryAddedAt: number | null;
  mediaBytes: number;
  novelCreatedAt: number;
  novelId: number;
  novelName: string;
  novelPath: string;
  novelUpdatedAt: number;
  page: string;
  pluginId: string;
  position: number;
  progress: number;
  readAt: number | null;
  releaseTime: string | null;
  status: string | null;
  summary: string | null;
  unread: unknown;
}

const LOCAL_PLUGIN_ID = "local";

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

export interface ChapterStorageRestoreResult {
  chapters: number;
  cursorChapterId?: number | null;
  scannedChapters?: number;
  novels: number;
}

export interface ChapterStorageRestoreOptions {
  afterChapterId?: number;
  chapterIds?: ReadonlySet<number>;
  contentOnly?: boolean;
  limit?: number;
}

const SELECT_CHAPTER_STORAGE_ROW = `
  SELECT
    c.id             AS chapterId,
    c.novel_id       AS novelId,
    c.path           AS chapterPath,
    c.name           AS chapterName,
    c.chapter_number AS chapterNumber,
    c.position,
    c.page,
    c.bookmark,
    c.unread,
    c.progress,
    c.content,
    c.content_type   AS contentType,
    c.content_bytes  AS contentBytes,
    c.media_bytes    AS mediaBytes,
    c.release_time   AS releaseTime,
    c.read_at        AS readAt,
    c.created_at     AS chapterCreatedAt,
    c.found_at       AS chapterFoundAt,
    c.updated_at     AS chapterUpdatedAt,
    n.plugin_id      AS pluginId,
    n.path           AS novelPath,
    n.name           AS novelName,
    n.cover,
    n.summary,
    n.author,
    n.artist,
    n.status,
    n.genres,
    n.in_library     AS inLibrary,
    n.is_local       AS isLocal,
    n.created_at     AS novelCreatedAt,
    n.updated_at     AS novelUpdatedAt,
    n.library_added_at AS libraryAddedAt,
    n.last_read_at   AS lastReadAt
  FROM chapter c
  JOIN novel n ON n.id = c.novel_id
`;

const SELECT_DOWNLOADED_CHAPTER_STORAGE_ROW = `
  ${SELECT_CHAPTER_STORAGE_ROW}
  WHERE c.id = $1
    AND c.is_downloaded = 1
    AND c.content IS NOT NULL
`;

const SELECT_DOWNLOADED_CHAPTER_STORAGE_ROWS_BY_NOVEL = `
  ${SELECT_CHAPTER_STORAGE_ROW}
  WHERE c.novel_id = $1
    AND c.is_downloaded = 1
    AND c.content IS NOT NULL
  ORDER BY c.position, c.id
`;

const SELECT_DOWNLOADED_CHAPTER_STORAGE_ROWS = `
  ${SELECT_CHAPTER_STORAGE_ROW}
  WHERE c.is_downloaded = 1
    AND c.content IS NOT NULL
  ORDER BY c.novel_id, c.position, c.id
`;

const SELECT_CHAPTER_STORAGE_METADATA_ROW = `
  ${SELECT_CHAPTER_STORAGE_ROW}
  WHERE c.id = $1
`;

const UPDATE_MIRRORED_CHAPTER_CONTENT = `
  UPDATE chapter
     SET is_downloaded = 1,
         content = $1,
          content_bytes = $2,
          media_bytes = $3,
          media_repair_needed = $4,
          content_type = $5,
          media_bytes_checked_at = unixepoch()
   WHERE id = $6
`;

const LEGACY_STORAGE_MANIFEST_FILE = "storage-manifest.json";
let legacyAndroidStorageManifestCleanup: Promise<void> | null = null;
let activeStorageMirrorSweepCancel: (() => void) | null = null;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function chapterContentExtension(contentType: string | undefined): string {
  if (contentType === "pdf") return "pdf";
  if (contentType === "markdown") return "html";
  if (contentType === "epub") return "html";
  return "html";
}

function chapterContentRelativePath(
  novel: ChapterStorageNovelPathInput,
  chapter: ChapterStorageChapterPathInput & { contentType?: string },
): string {
  const extension = chapterContentExtension(chapter.contentType);
  return buildChapterContentRelativePath(novel, chapter, extension);
}

async function deleteLegacyAndroidStorageManifest(): Promise<void> {
  legacyAndroidStorageManifestCleanup ??= deleteAndroidStoragePath(
    LEGACY_STORAGE_MANIFEST_FILE,
  ).catch(() => {
    legacyAndroidStorageManifestCleanup = null;
  });
  await legacyAndroidStorageManifestCleanup;
}

async function deleteLegacyStorageManifest(): Promise<void> {
  if (isAndroidRuntime()) {
    await deleteLegacyAndroidStorageManifest();
    return;
  }
  await invoke("chapter_content_mirror_cleanup_legacy_manifest");
}

function storageMetadata(row: ChapterStorageRow) {
  return {
    novel: {
      id: row.novelId,
      pluginId: row.pluginId,
      path: row.novelPath,
      name: row.novelName,
      cover: row.cover,
      summary: row.summary,
      author: row.author,
      artist: row.artist,
      status: row.status,
      genres: row.genres,
      inLibrary: sqliteBoolean(row.inLibrary),
      isLocal: isLocalNovel(row.pluginId, row.isLocal),
      createdAt: row.novelCreatedAt,
      updatedAt: row.novelUpdatedAt,
      libraryAddedAt: row.libraryAddedAt,
      lastReadAt: row.lastReadAt,
    },
    chapter: {
      id: row.chapterId,
      novelId: row.novelId,
      path: row.chapterPath,
      name: row.chapterName,
      chapterNumber: row.chapterNumber,
      position: row.position,
      page: row.page,
      bookmark: sqliteBoolean(row.bookmark),
      unread: sqliteBoolean(row.unread),
      progress: row.progress,
      isDownloaded: true,
      contentType: normalizeChapterContentType(
        row.contentType ?? DEFAULT_CHAPTER_CONTENT_TYPE,
      ),
      contentBytes: row.contentBytes,
      mediaBytes: row.mediaBytes,
      releaseTime: row.releaseTime,
      readAt: row.readAt,
      createdAt: row.chapterCreatedAt,
      foundAt: row.chapterFoundAt,
      updatedAt: row.chapterUpdatedAt,
    },
  };
}

async function readStoredChapterContentFile(
  contentFile: string,
): Promise<string | null> {
  if (isAndroidRuntime()) {
    return readAndroidStorageText(contentFile);
  }
  return invoke<string | null>("chapter_content_mirror_read_file", {
    contentFile,
  });
}

async function restoreStoredChapterContentRows(
  options: ChapterStorageRestoreOptions,
): Promise<ChapterStorageRestoreResult> {
  if (options.chapterIds && options.chapterIds.size === 0) {
    return {
      chapters: 0,
      cursorChapterId: null,
      novels: 0,
      scannedChapters: 0,
    };
  }

  const db = await getDb();
  const params: unknown[] = [];
  const clauses = ["c.content IS NULL"];
  if (options.chapterIds && options.chapterIds.size > 0) {
    const ids = [...options.chapterIds];
    const placeholders = ids.map((id) => {
      params.push(id);
      return `$${params.length}`;
    });
    clauses.push(`c.id IN (${placeholders.join(", ")})`);
  } else if (options.afterChapterId && options.afterChapterId > 0) {
    params.push(options.afterChapterId);
    clauses.push(`c.id > $${params.length}`);
  }
  const limit = options.limit === undefined
    ? null
    : clampBackfillLimit(options.limit);
  const limitClause = limit ? `\n  LIMIT $${params.length + 1}` : "";
  if (limit) params.push(limit);
  const rows = await db.select<ChapterStorageRow[]>(
    `${SELECT_CHAPTER_STORAGE_ROW}
  WHERE ${clauses.join(" AND ")}
  ORDER BY c.id${limitClause}`,
    params,
  );
  let restoredChapters = 0;

  await deleteLegacyStorageManifest();

  for (const row of rows) {
    const metadata = storageMetadata(row);
    const contentFile = chapterContentRelativePath(
      metadata.novel,
      metadata.chapter,
    );
    const content = await readStoredChapterContentFile(contentFile);
    if (content === null) continue;
    const contentType = normalizeChapterContentType(
      metadata.chapter.contentType ?? DEFAULT_CHAPTER_CONTENT_TYPE,
    );
    const mediaBytes = await getStoredChapterMediaBytes(content, {
      chapterId: row.chapterId,
      chapterName: row.chapterName,
      chapterNumber: row.chapterNumber,
      chapterPosition: row.position,
      novelId: row.novelId,
      novelName: row.novelName,
      novelPath: row.novelPath,
      sourceId: row.pluginId,
    });
    await db.execute(UPDATE_MIRRORED_CHAPTER_CONTENT, [
      content,
      utf8ByteLength(content),
      mediaBytes,
      chapterMediaRepairFlag(content, contentType),
      contentType,
      row.chapterId,
    ]);
    restoredChapters += 1;
  }

  return {
    chapters: restoredChapters,
    cursorChapterId: rows.at(-1)?.chapterId ?? null,
    novels: 0,
    scannedChapters: rows.length,
  };
}

export async function mirrorStoredChapterContent(
  chapterId: number,
): Promise<void> {
  if (!isTauriRuntime()) return;

  const db = await getDb();
  const rows = await db.select<ChapterStorageRow[]>(
    SELECT_DOWNLOADED_CHAPTER_STORAGE_ROW,
    [chapterId],
  );
  const row = rows[0];
  if (!row?.content) return;
  const content = row.content;

  if (isAndroidRuntime()) {
    const metadata = storageMetadata(row);
    const novel = metadata.novel;
    const chapter = metadata.chapter;
    const contentFile = chapterContentRelativePath(novel, chapter);
    await deleteLegacyAndroidStorageManifest();
    await writeAndroidStorageText(contentFile, content);
    return;
  }

  await invoke("chapter_content_mirror_store", {
    chapterId,
    content: row.content,
    metadata: storageMetadata(row),
  });
}

async function mirrorStoredChapterContentRow(
  row: ChapterStorageRow,
): Promise<void> {
  if (!row.content) return;
  const metadata = storageMetadata(row);

  if (isAndroidRuntime()) {
    const contentFile = chapterContentRelativePath(
      metadata.novel,
      metadata.chapter,
    );
    await deleteLegacyAndroidStorageManifest();
    await writeAndroidStorageText(contentFile, row.content);
    return;
  }

  await invoke("chapter_content_mirror_store", {
    chapterId: row.chapterId,
    content: row.content,
    metadata,
  });
}

export async function mirrorStoredNovelChapters(
  novelId: number,
): Promise<void> {
  if (!isTauriRuntime()) return;

  const db = await getDb();
  const rows = await db.select<ChapterStorageRow[]>(
    SELECT_DOWNLOADED_CHAPTER_STORAGE_ROWS_BY_NOVEL,
    [novelId],
  );
  for (const row of rows) {
    await mirrorStoredChapterContentRow(row);
  }
}

export async function mirrorAllStoredChapterContent(): Promise<number> {
  if (!isTauriRuntime()) return 0;

  const db = await getDb();
  const rows = await db.select<ChapterStorageRow[]>(
    SELECT_DOWNLOADED_CHAPTER_STORAGE_ROWS,
  );
  for (const row of rows) {
    await mirrorStoredChapterContentRow(row);
  }
  return rows.length;
}

export async function clearStoredChapterContentMirror(
  chapterId: number,
): Promise<void> {
  if (!isTauriRuntime()) return;
  if (isAndroidRuntime()) {
    const db = await getDb();
    const rows = await db.select<ChapterStorageRow[]>(
      SELECT_CHAPTER_STORAGE_METADATA_ROW,
      [chapterId],
    );
    const row = rows[0];
    if (!row) return;
    const metadata = storageMetadata(row);
    await deleteLegacyAndroidStorageManifest();
    await deleteAndroidStoragePath(
      chapterContentRelativePath(metadata.novel, metadata.chapter),
    );
    return;
  }
  await invoke("chapter_content_mirror_clear", { chapterId });
}

export async function restoreChapterContentStorageMirror(
  options: ChapterStorageRestoreOptions = {},
): Promise<ChapterStorageRestoreResult> {
  if (!isTauriRuntime()) return { chapters: 0, novels: 0 };
  return restoreStoredChapterContentRows(options);
}

export function startChapterContentStorageMirrorSweep(
  options: { batchSize?: number; delayMs?: number } = {},
): () => void {
  if (!isTauriRuntime()) return () => undefined;
  if (activeStorageMirrorSweepCancel) return () => undefined;

  const batchSize = clampBackfillLimit(options.batchSize ?? 25, 25);
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 250));
  let cancelled = false;
  let cursorChapterId = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (activeStorageMirrorSweepCancel === cancel) {
      activeStorageMirrorSweepCancel = null;
    }
  };

  const schedule = () => {
    if (cancelled) return;
    timer = setTimeout(() => {
      timer = null;
      void step();
    }, delayMs);
  };

  async function step(): Promise<void> {
    if (cancelled) return;
    try {
      const result = await restoreChapterContentStorageMirror({
        afterChapterId: cursorChapterId,
        contentOnly: true,
        limit: batchSize,
      });
      if (cancelled) return;
      cursorChapterId = result.cursorChapterId ?? cursorChapterId;
      if ((result.scannedChapters ?? 0) >= batchSize && cursorChapterId > 0) {
        schedule();
        return;
      }
    } catch (unknownError) {
      // eslint-disable-next-line no-console
      console.warn("[storage] chapter content mirror sweep failed", unknownError);
    }
    cleanup();
  }

  function cancel(): void {
    cancelled = true;
    if (timer) clearTimeout(timer);
    cleanup();
  }

  activeStorageMirrorSweepCancel = cancel;
  schedule();
  return cancel;
}
