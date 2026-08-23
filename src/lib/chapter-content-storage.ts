import { invoke } from "@tauri-apps/api/core";
import {
  adoptStoredChapterContentMetadata,
  markStoredChapterContentMissing,
  saveChapterContentMetadata,
  saveChapterPartialContentMetadata,
  type ChapterMutationResult,
  type SaveChapterContentOptions,
} from "../db/queries/chapter";
import { getDb } from "../db/client";
import {
  deleteAndroidStoragePath,
  inspectAndroidChapterArtifacts,
  readAndroidStorageText,
  renameAndroidStoragePath,
  writeAndroidStorageText,
} from "./android-storage";
import {
  DEFAULT_CHAPTER_CONTENT_TYPE,
  normalizeChapterContentType,
  storedChapterContentType,
  type ChapterContentType,
} from "./chapter-content";
import {
  chapterStorageIdentityPrefix,
  chapterStorageRelativeDir,
  chapterContentRelativePath as buildChapterContentRelativePath,
  novelStorageIdentitySuffix,
  sourceStorageRelativeDir,
  type ChapterStorageChapterPathInput,
  type ChapterStorageNovelPathInput,
} from "./chapter-storage-path";
import {
  clearResolvedChapterStorageDirs,
  forgetResolvedChapterStorageDir,
  rememberResolvedChapterStorageDir,
  resolvedChapterStorageDir,
} from "./chapter-storage-resolution";
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
  contentBytes: number;
  sourceContentType: string;
  storedContentType: string | null;
  cover: string | null;
  genres: string | null;
  inLibrary: unknown;
  isDownloaded: unknown;
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

export type StoredChapterArtifacts =
  | {
      status: "missing";
      contentFile: null;
      contentBytes: 0;
      mediaBytes: 0;
    }
  | {
      status: "present";
      contentFile: string;
      contentBytes: number;
      mediaBytes: number;
    };

interface StoredChapterArtifactsInspection {
  status: "missing" | "present";
  contentFile: string | null;
  contentBytes: number;
  mediaBytes: number;
}

export interface ReconciledStoredChapterContent {
  artifacts: StoredChapterArtifacts;
  content: string | null;
}

export interface ChapterStorageRestoreResult {
  chapters: number;
  cursorChapterId: number | null;
  novels: number;
  scannedChapters: number;
}

export interface ChapterStorageRestoreOptions {
  afterChapterId?: number;
  chapterIds?: ReadonlySet<number>;
  limit?: number;
}

const LOCAL_PLUGIN_ID = "local";
const CHAPTER_PARTIAL_CONTENT_FILE = ".chapter-content.partial";

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
    c.is_downloaded  AS isDownloaded,
    c.content_type   AS sourceContentType,
    c.stored_content_type AS storedContentType,
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

let activeStorageMirrorSweepCancel: (() => void) | null = null;

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

function chapterPartialContentRelativePath(
  novel: ChapterStorageNovelPathInput,
  chapter: ChapterStorageChapterPathInput,
): string {
  return `${chapterStorageRelativeDir(novel, chapter)}/${CHAPTER_PARTIAL_CONTENT_FILE}`;
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
      isDownloaded: sqliteBoolean(row.isDownloaded),
      contentType: normalizeChapterContentType(
        row.storedContentType ??
          row.sourceContentType ??
          DEFAULT_CHAPTER_CONTENT_TYPE,
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

async function getChapterStorageRow(chapterId: number) {
  const db = await getDb();
  const rows = await db.select<ChapterStorageRow[]>(
    SELECT_CHAPTER_STORAGE_METADATA_ROW,
    [chapterId],
  );
  return rows[0] ?? null;
}

async function getChapterStorageMetadata(chapterId: number) {
  const row = await getChapterStorageRow(chapterId);
  return row ? storageMetadata(row) : null;
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

function artifactLookupInput(metadata: ReturnType<typeof storageMetadata>) {
  const preferredContentFile = chapterContentRelativePath(
    metadata.novel,
    metadata.chapter,
  );
  return {
    preferredChapterDir: chapterStorageRelativeDir(
      metadata.novel,
      metadata.chapter,
    ),
    sourceDir: sourceStorageRelativeDir(metadata.novel),
    novelIdentitySuffix: novelStorageIdentitySuffix(metadata.novel),
    chapterIdentityPrefix: chapterStorageIdentityPrefix(metadata.chapter),
    preferredContentFileName:
      preferredContentFile.split("/").at(-1) ?? "content.html",
  };
}

function normalizeStoredChapterArtifacts(
  value: StoredChapterArtifactsInspection,
): StoredChapterArtifacts {
  if (value.status !== "present") {
    return {
      status: "missing",
      contentFile: null,
      contentBytes: 0,
      mediaBytes: 0,
    };
  }
  if (!value.contentFile) {
    throw new Error("Stored chapter inspection returned no content file.");
  }
  return {
    status: "present",
    contentFile: value.contentFile,
    contentBytes: Math.max(0, value.contentBytes),
    mediaBytes: Math.max(0, value.mediaBytes),
  };
}

async function inspectStoredChapterArtifactsForRow(
  row: ChapterStorageRow,
): Promise<StoredChapterArtifacts> {
  if (!isTauriRuntime()) {
    return {
      status: "missing",
      contentFile: null,
      contentBytes: 0,
      mediaBytes: 0,
    };
  }
  const input = artifactLookupInput(storageMetadata(row));
  const artifacts = isAndroidRuntime()
    ? await inspectAndroidChapterArtifacts(input)
    : await invoke<StoredChapterArtifactsInspection>(
        "chapter_content_mirror_inspect",
        input,
      );
  return normalizeStoredChapterArtifacts(artifacts);
}

async function reconcileStoredChapterStorageRow(
  row: ChapterStorageRow,
): Promise<StoredChapterArtifacts> {
  const artifacts = await inspectStoredChapterArtifactsForRow(row);
  if (artifacts.status === "present") {
    rememberResolvedChapterStorageDir(row.chapterId, artifacts.contentFile);
    const normalizedContentType = normalizeChapterContentType(
      row.storedContentType ?? row.sourceContentType,
    );
    await adoptStoredChapterContentMetadata(
      row.chapterId,
      artifacts.contentBytes,
      artifacts.mediaBytes,
      artifacts.contentFile.endsWith(".pdf")
        ? "pdf"
        : normalizedContentType === "pdf"
          ? "html"
          : storedChapterContentType(normalizedContentType),
    );
  } else if (
    sqliteBoolean(row.isDownloaded) ||
    row.contentBytes > 0 ||
    row.mediaBytes > 0
  ) {
    forgetResolvedChapterStorageDir(row.chapterId);
    await markStoredChapterContentMissing(row.chapterId);
  } else {
    forgetResolvedChapterStorageDir(row.chapterId);
  }
  return artifacts;
}

export async function reconcileStoredChapterContent(
  chapterId: number,
): Promise<StoredChapterArtifacts> {
  if (!isTauriRuntime()) {
    return {
      status: "missing",
      contentFile: null,
      contentBytes: 0,
      mediaBytes: 0,
    };
  }
  const row = await getChapterStorageRow(chapterId);
  if (!row) {
    return {
      status: "missing",
      contentFile: null,
      contentBytes: 0,
      mediaBytes: 0,
    };
  }
  return reconcileStoredChapterStorageRow(row);
}

export async function readStoredChapterContentMirror(
  chapterId: number,
): Promise<string | null> {
  return (await reconcileAndReadStoredChapterContent(chapterId)).content;
}

export async function reconcileAndReadStoredChapterContent(
  chapterId: number,
): Promise<ReconciledStoredChapterContent> {
  const artifacts = await reconcileStoredChapterContent(chapterId);
  if (artifacts.status !== "present" || !artifacts.contentFile) {
    return { artifacts, content: null };
  }
  const content = await readStoredChapterContentFile(artifacts.contentFile);
  if (content !== null) return { artifacts, content };
  forgetResolvedChapterStorageDir(chapterId);
  await markStoredChapterContentMissing(chapterId);
  return {
    artifacts: {
      status: "missing",
      contentFile: null,
      contentBytes: 0,
      mediaBytes: 0,
    },
    content: null,
  };
}

export async function readStoredChapterPartialContentMirror(
  chapterId: number,
): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const metadata = await getChapterStorageMetadata(chapterId);
  if (!metadata) return null;
  return readStoredChapterContentFile(
    chapterPartialContentRelativePath(metadata.novel, metadata.chapter),
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
    const preferredContentPath = chapterContentRelativePath(
      metadata.novel,
      metadata.chapter,
    );
    const contentFileName =
      preferredContentPath.split("/").at(-1) ?? "content.html";
    const preferredChapterDir = chapterStorageRelativeDir(
      metadata.novel,
      metadata.chapter,
    );
    const chapterDir =
      resolvedChapterStorageDir(chapterId) ?? preferredChapterDir;
    const contentPath = `${chapterDir}/${contentFileName}`;
    const tempPath = `${contentPath}.tmp`;
    await writeAndroidStorageText(tempPath, content);
    await renameAndroidStoragePath(tempPath, contentFileName);
    await Promise.all(
      ["content.html", "content.pdf"]
        .filter((fileName) => fileName !== contentFileName)
        .map((fileName) => deleteAndroidStoragePath(`${chapterDir}/${fileName}`)),
    );
    await deleteAndroidStoragePath(
      `${chapterDir}/${CHAPTER_PARTIAL_CONTENT_FILE}`,
    );
    if (chapterDir !== preferredChapterDir) {
      await deleteAndroidStoragePath(
        chapterPartialContentRelativePath(metadata.novel, metadata.chapter),
      );
    }
    return;
  }

  await invoke("chapter_content_mirror_store", {
    chapterId,
    content,
    metadata,
  });
}

async function writeStoredChapterPartialContent(
  chapterId: number,
  content: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const metadata = await getChapterStorageMetadata(chapterId);
  if (!metadata) return;
  if (isAndroidRuntime()) {
    await writeAndroidStorageText(
      chapterPartialContentRelativePath(metadata.novel, metadata.chapter),
      content,
    );
    return;
  }
  await invoke("chapter_content_mirror_store_partial", {
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
  await writeStoredChapterPartialContent(chapterId, html);
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
    await deleteAndroidStoragePath(
      chapterPartialContentRelativePath(metadata.novel, metadata.chapter),
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
    await deleteAndroidStoragePath(
      chapterPartialContentRelativePath(metadata.novel, metadata.chapter),
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

export async function restoreChapterContentStorageMirror(
  options: ChapterStorageRestoreOptions = {},
): Promise<ChapterStorageRestoreResult> {
  if (!isTauriRuntime() || options.chapterIds?.size === 0) {
    return {
      chapters: 0,
      cursorChapterId: null,
      novels: 0,
      scannedChapters: 0,
    };
  }

  const db = await getDb();
  const params: unknown[] = [];
  const clauses = ["n.is_local = 0"];
  if (options.chapterIds && options.chapterIds.size > 0) {
    const placeholders = [...options.chapterIds].map((chapterId) => {
      params.push(chapterId);
      return `$${params.length}`;
    });
    clauses.push(`c.id IN (${placeholders.join(", ")})`);
  } else if (options.afterChapterId && options.afterChapterId > 0) {
    params.push(options.afterChapterId);
    clauses.push(`c.id > $${params.length}`);
  }
  const limit =
    options.limit === undefined ? null : clampBackfillLimit(options.limit);
  const limitClause = limit ? `\n  LIMIT $${params.length + 1}` : "";
  if (limit) params.push(limit);
  const rows = await db.select<ChapterStorageRow[]>(
    `${SELECT_CHAPTER_STORAGE_ROW}
  WHERE ${clauses.join(" AND ")}
  ORDER BY c.id${limitClause}`,
    params,
  );
  let restoredChapters = 0;
  for (const row of rows) {
    const artifacts = await reconcileStoredChapterStorageRow(row);
    if (artifacts.status === "present") restoredChapters += 1;
  }
  return {
    chapters: restoredChapters,
    cursorChapterId: rows.at(-1)?.chapterId ?? null,
    novels: 0,
    scannedChapters: rows.length,
  };
}

export function startChapterContentStorageMirrorSweep(
  options: {
    batchSize?: number;
    delayMs?: number;
    onComplete?: () => void;
  } = {},
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
        limit: batchSize,
      });
      if (cancelled) return;
      cursorChapterId = result.cursorChapterId ?? cursorChapterId;
      if (result.scannedChapters >= batchSize && cursorChapterId > 0) {
        schedule();
        return;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[storage] failed to reconcile stored chapters", error);
      cleanup();
      return;
    }
    cleanup();
    options.onComplete?.();
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

export function restartChapterContentStorageMirrorSweep(
  options: Parameters<typeof startChapterContentStorageMirrorSweep>[0] = {},
): () => void {
  activeStorageMirrorSweepCancel?.();
  clearResolvedChapterStorageDirs();
  return startChapterContentStorageMirrorSweep(options);
}
