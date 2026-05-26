import { invoke } from "@tauri-apps/api/core";
import {
  saveChapterContentMetadata,
  saveChapterPartialContentMetadata,
  type ChapterMutationResult,
  type SaveChapterContentOptions,
} from "../db/queries/chapter";
import { getDb } from "../db/client";
import {
  deleteAndroidStoragePath,
  readAndroidStorageText,
  writeAndroidStorageText,
} from "./android-storage";
import {
  DEFAULT_CHAPTER_CONTENT_TYPE,
  normalizeChapterContentType,
  type ChapterContentType,
} from "./chapter-content";
import {
  chapterContentRelativePath as buildChapterContentRelativePath,
  type ChapterStorageChapterPathInput,
  type ChapterStorageNovelPathInput,
} from "./chapter-storage-path";
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

const SELECT_CHAPTER_STORAGE_METADATA_ROW = `
  ${SELECT_CHAPTER_STORAGE_ROW}
  WHERE c.id = $1
`;

const SELECT_DOWNLOADED_CHAPTER_STORAGE_ROWS_BY_NOVEL = `
  ${SELECT_CHAPTER_STORAGE_ROW}
  WHERE c.novel_id = $1
    AND c.is_downloaded = 1
  ORDER BY c.position, c.id
`;

const SELECT_DOWNLOADED_CHAPTER_STORAGE_ROWS = `
  ${SELECT_CHAPTER_STORAGE_ROW}
  WHERE c.is_downloaded = 1
  ORDER BY c.novel_id, c.position, c.id
`;

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

async function getChapterStorageMetadata(chapterId: number) {
  const db = await getDb();
  const rows = await db.select<ChapterStorageRow[]>(
    SELECT_CHAPTER_STORAGE_METADATA_ROW,
    [chapterId],
  );
  const row = rows[0];
  if (!row) return null;
  return storageMetadata(row);
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

function isOptionalAndroidStorageReadFailure(error: unknown): boolean {
  if (!isAndroidRuntime() || !(error instanceof Error)) return false;
  return /permission|denied|hidden|not accessible|unavailable|cannot open storage file/i.test(
    error.message,
  );
}

async function readOptionalStoredChapterContentFile(
  contentFile: string,
): Promise<string | null> {
  try {
    return await readStoredChapterContentFile(contentFile);
  } catch (error) {
    if (isOptionalAndroidStorageReadFailure(error)) return null;
    throw error;
  }
}

export async function readStoredChapterContentMirror(
  chapterId: number,
): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const metadata = await getChapterStorageMetadata(chapterId);
  if (!metadata) return null;
  return readOptionalStoredChapterContentFile(
    chapterContentRelativePath(metadata.novel, metadata.chapter),
  );
}

async function writeStoredChapterContent(
  chapterId: number,
  content: string,
  contentType?: ChapterContentType,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const metadata = await getChapterStorageMetadata(chapterId);
  if (!metadata) return;
  if (contentType !== undefined) {
    metadata.chapter.contentType = normalizeChapterContentType(contentType);
  }

  if (isAndroidRuntime()) {
    await writeAndroidStorageText(
      chapterContentRelativePath(metadata.novel, metadata.chapter),
      content,
    );
    return;
  }

  await invoke("chapter_content_mirror_store", {
    chapterId,
    content,
    metadata,
  });
}

export async function writeStoredChapterContentMirror(
  chapterId: number,
  content: string,
): Promise<void> {
  await writeStoredChapterContent(chapterId, content);
}

export async function saveStoredChapterContent(
  chapterId: number,
  html: string,
  contentType: ChapterContentType = DEFAULT_CHAPTER_CONTENT_TYPE,
  options: SaveChapterContentOptions = {},
): Promise<ChapterMutationResult> {
  await writeStoredChapterContent(chapterId, html, contentType);
  const result = await saveChapterContentMetadata(
    chapterId,
    html,
    contentType,
    options,
  );
  return result;
}

export async function saveStoredChapterPartialContent(
  chapterId: number,
  html: string,
  contentType: ChapterContentType = DEFAULT_CHAPTER_CONTENT_TYPE,
): Promise<ChapterMutationResult> {
  await writeStoredChapterContent(chapterId, html, contentType);
  const result = await saveChapterPartialContentMetadata(
    chapterId,
    html,
    contentType,
  );
  return result;
}

export async function clearStoredChapterContentMirror(
  chapterId: number,
): Promise<void> {
  if (!isTauriRuntime()) return;
  if (isAndroidRuntime()) {
    const metadata = await getChapterStorageMetadata(chapterId);
    if (!metadata) return;
    await deleteAndroidStoragePath(
      chapterContentRelativePath(metadata.novel, metadata.chapter),
    );
    return;
  }
  await invoke("chapter_content_mirror_clear", { chapterId });
}

async function clearStoredChapterContentRow(
  row: ChapterStorageRow,
): Promise<void> {
  if (isAndroidRuntime()) {
    const metadata = storageMetadata(row);
    await deleteAndroidStoragePath(
      chapterContentRelativePath(metadata.novel, metadata.chapter),
    );
    return;
  }
  await invoke("chapter_content_mirror_clear", { chapterId: row.chapterId });
}

export async function clearStoredNovelChapterContentMirrors(
  novelId: number,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const db = await getDb();
  const rows = await db.select<ChapterStorageRow[]>(
    SELECT_DOWNLOADED_CHAPTER_STORAGE_ROWS_BY_NOVEL,
    [novelId],
  );
  await Promise.all(rows.map(clearStoredChapterContentRow));
}

export async function clearAllStoredChapterContentMirrors(): Promise<void> {
  if (!isTauriRuntime()) return;
  const db = await getDb();
  const rows = await db.select<ChapterStorageRow[]>(
    SELECT_DOWNLOADED_CHAPTER_STORAGE_ROWS,
  );
  await Promise.all(rows.map(clearStoredChapterContentRow));
}
