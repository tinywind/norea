import { getDb } from "../db/client";
import {
  adoptStoredChapterContentMetadata,
  markStoredChapterContentMissing,
  saveChapterContentMetadata,
  saveChapterPartialContentMetadata,
  type ChapterMutationResult,
  type SaveChapterContentOptions,
} from "../db/queries/chapter";
import { sqliteBoolean } from "../db/sqlite-value";
import {
  DEFAULT_CHAPTER_CONTENT_TYPE,
  normalizeChapterContentType,
  storedChapterContentType,
  type ChapterContentType,
} from "./chapter-content";
import {
  chapterContentRelativePath,
  chapterPartialContentRelativePath,
  clearChapterContentFiles,
  inspectChapterContentArtifacts,
  readStoredChapterContentFile,
  writeChapterContentFile,
  writeChapterPartialContentFile,
  type ChapterContentStorageIdentity,
  type StoredChapterArtifactsInspection,
} from "./chapter-content/storage-platform";
import {
  chapterStorageIdentityPrefix,
  chapterStorageRelativeDir,
  novelStorageIdentitySuffix,
  sourceStorageRelativeDir,
} from "./chapter-storage-path";
import {
  clearResolvedChapterStorageDirs,
  forgetResolvedChapterStorageDir,
  rememberResolvedChapterStorageDir,
} from "./chapter-storage-resolution";
import { clampBackfillLimit } from "./performance-budgets";
import { isTauriRuntime } from "./tauri-runtime";

interface ChapterStorageRow {
  chapterId: number;
  chapterName: string;
  chapterNumber: string | null;
  contentBytes: number;
  sourceContentType: string;
  storedContentType: string | null;
  isDownloaded: unknown;
  mediaBytes: number;
  novelId: number;
  novelName: string;
  novelPath: string;
  pluginId: string;
  position: number;
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

const SELECT_CHAPTER_STORAGE_ROW = `
  SELECT
    c.id AS chapterId,
    c.novel_id AS novelId,
    c.name AS chapterName,
    c.chapter_number AS chapterNumber,
    c.position,
    c.is_downloaded AS isDownloaded,
    c.content_type AS sourceContentType,
    c.stored_content_type AS storedContentType,
    c.content_bytes AS contentBytes,
    c.media_bytes AS mediaBytes,
    n.plugin_id AS pluginId,
    n.path AS novelPath,
    n.name AS novelName
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

function storageMetadata(
  row: ChapterStorageRow,
): ChapterContentStorageIdentity {
  return {
    novel: {
      id: row.novelId,
      pluginId: row.pluginId,
      path: row.novelPath,
      name: row.novelName,
    },
    chapter: {
      id: row.chapterId,
      name: row.chapterName,
      chapterNumber: row.chapterNumber,
      position: row.position,
      contentType: normalizeChapterContentType(
        row.storedContentType ??
          row.sourceContentType ??
          DEFAULT_CHAPTER_CONTENT_TYPE,
      ),
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
  const artifacts = await inspectChapterContentArtifacts(input);
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
  const identity =
    contentType === undefined
      ? metadata
      : {
          ...metadata,
          chapter: {
            ...metadata.chapter,
            contentType: normalizeChapterContentType(contentType),
          },
        };
  await writeChapterContentFile(chapterId, content, identity);
}

async function writeStoredChapterPartialContent(
  chapterId: number,
  content: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const metadata = await getChapterStorageMetadata(chapterId);
  if (!metadata) return;
  await writeChapterPartialContentFile(content, metadata);
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
  await clearChapterContentFiles(chapterId, () =>
    getChapterStorageMetadata(chapterId),
  );
}

async function clearStoredChapterContentRow(
  row: ChapterStorageRow,
): Promise<void> {
  await clearChapterContentFiles(row.chapterId, () => storageMetadata(row));
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
    try {
      const artifacts = await reconcileStoredChapterStorageRow(row);
      if (artifacts.status === "present") restoredChapters += 1;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[storage] failed to reconcile stored chapter", {
        chapterId: row.chapterId,
        error,
      });
    }
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
