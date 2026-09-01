/**
 * Backup file format v1.
 *
 * The on-disk artifact is a `.zip` whose entries are written and
 * read by `pack.ts` and `unpack.ts` in later iterations. This
 * module owns the envelope: the JSON payload that lives in
 * `manifest.json` inside the zip. Keeping the format self-describing
 * lets future format versions evolve without breaking older backups.
 *
 * The project intentionally uses its own backup format instead of
 * preserving upstream backup zip compatibility.
 */

import {
  DEFAULT_CHAPTER_CONTENT_TYPE,
  normalizeChapterContentType,
  storedChapterContentType,
  type ChapterContentType,
} from "../chapter-content";

export const BACKUP_FORMAT_VERSION = 1 as const;

export interface BackupNovel {
  id: number;
  pluginId: string;
  path: string;
  name: string;
  cover: string | null;
  summary: string | null;
  author: string | null;
  artist: string | null;
  status: string | null;
  genres: string | null;
  inLibrary: boolean;
  isLocal: boolean;
  createdAt: number;
  updatedAt: number;
  libraryAddedAt: number | null;
  lastReadAt: number | null;
}

export interface BackupChapter {
  id: number;
  novelId: number;
  path: string;
  name: string;
  chapterNumber: string | null;
  position: number;
  page: string;
  bookmark: boolean;
  unread: boolean;
  progress: number;
  isDownloaded: boolean;
  /** Plugin acquisition type. Falls back to contentType for older v1 backups. */
  sourceContentType?: ChapterContentType;
  /** Physical/effective type of the backed-up content body. */
  contentType?: ChapterContentType;
  /** Inline reader body. Null when the chapter wasn't downloaded yet. */
  content: string | null;
  /** Bytes occupied by local chapter media files referenced by content. */
  mediaBytes?: number;
  releaseTime: string | null;
  readAt: number | null;
  createdAt: number;
  foundAt: number;
  updatedAt: number;
}

export interface BackupCategory {
  id: number;
  name: string;
  sort: number;
  isSystem: boolean;
}

export interface BackupNovelCategory {
  id: number;
  novelId: number;
  categoryId: number;
}

export interface BackupRepository {
  id: number;
  url: string;
  name: string | null;
  addedAt: number;
}

export interface BackupInstalledPlugin {
  id: string;
  name: string;
  lang: string;
  version: string;
  iconUrl: string;
  sourceUrl: string;
  sourceCode: string;
  installedAt: number;
}

export interface BackupSetting {
  key: string;
  value: string;
}

export interface BackupManifest {
  version: typeof BACKUP_FORMAT_VERSION;
  /** Unix-epoch seconds when the backup was created. */
  exportedAt: number;
  novels: BackupNovel[];
  chapters: BackupChapter[];
  categories: BackupCategory[];
  novelCategories: BackupNovelCategory[];
  /** The app stores at most one configured plugin repository. */
  repositories: BackupRepository[];
  installedPlugins?: BackupInstalledPlugin[];
  settings?: BackupSetting[];
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupFormatError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray<T>(
  value: unknown,
  field: string,
  guard: (item: unknown) => item is T,
): T[] {
  if (!Array.isArray(value)) {
    throw new BackupFormatError(`${field} is not an array.`);
  }
  for (const item of value) {
    if (!guard(item)) {
      throw new BackupFormatError(`${field} contains a malformed entry.`);
    }
  }
  return value;
}

function asOptionalArray<T>(
  value: unknown,
  field: string,
  guard: (item: unknown) => item is T,
): T[] | undefined {
  if (value === undefined) return undefined;
  return asArray(value, field, guard);
}

function isNovel(value: unknown): value is BackupNovel {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.pluginId === "string" &&
    typeof value.path === "string" &&
    typeof value.name === "string" &&
    typeof value.inLibrary === "boolean" &&
    typeof value.isLocal === "boolean" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    (value.libraryAddedAt === null ||
      value.libraryAddedAt === undefined ||
      typeof value.libraryAddedAt === "number")
  );
}

function isChapter(value: unknown): value is BackupChapter {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.novelId === "number" &&
    typeof value.path === "string" &&
    typeof value.name === "string" &&
    typeof value.position === "number" &&
    typeof value.page === "string" &&
    typeof value.bookmark === "boolean" &&
    typeof value.unread === "boolean" &&
    typeof value.progress === "number" &&
    typeof value.isDownloaded === "boolean" &&
    (value.contentType === undefined ||
      value.contentType === "html" ||
      value.contentType === "text" ||
      value.contentType === "pdf" ||
      value.contentType === "markdown" ||
      value.contentType === "epub") &&
    (value.sourceContentType === undefined ||
      value.sourceContentType === "html" ||
      value.sourceContentType === "text" ||
      value.sourceContentType === "pdf" ||
      value.sourceContentType === "markdown" ||
      value.sourceContentType === "epub") &&
    (value.mediaBytes === undefined || typeof value.mediaBytes === "number") &&
    typeof value.updatedAt === "number" &&
    (value.createdAt === undefined || typeof value.createdAt === "number") &&
    (value.foundAt === undefined || typeof value.foundAt === "number")
  );
}

function normalizeNovel(novel: BackupNovel): BackupNovel {
  return {
    ...novel,
    libraryAddedAt: novel.libraryAddedAt ?? null,
    lastReadAt: novel.lastReadAt ?? null,
  };
}

function normalizeChapter(chapter: BackupChapter): BackupChapter {
  const createdAt = chapter.createdAt ?? chapter.updatedAt;
  const contentType = normalizeChapterContentType(
    chapter.contentType ?? DEFAULT_CHAPTER_CONTENT_TYPE,
  );
  return {
    ...chapter,
    sourceContentType: normalizeChapterContentType(
      chapter.sourceContentType ?? contentType,
    ),
    contentType: storedChapterContentType(contentType),
    mediaBytes: chapter.mediaBytes ?? 0,
    createdAt,
    foundAt: chapter.foundAt ?? Math.max(createdAt, chapter.updatedAt),
  };
}

function isCategory(value: unknown): value is BackupCategory {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.name === "string" &&
    typeof value.sort === "number" &&
    typeof value.isSystem === "boolean"
  );
}

function isNovelCategory(value: unknown): value is BackupNovelCategory {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.novelId === "number" &&
    typeof value.categoryId === "number"
  );
}

function isRepository(value: unknown): value is BackupRepository {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.url === "string" &&
    typeof value.addedAt === "number"
  );
}

function isInstalledPlugin(value: unknown): value is BackupInstalledPlugin {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.lang === "string" &&
    typeof value.version === "string" &&
    typeof value.iconUrl === "string" &&
    typeof value.sourceUrl === "string" &&
    typeof value.sourceCode === "string" &&
    typeof value.installedAt === "number"
  );
}

function isSetting(value: unknown): value is BackupSetting {
  if (!isObject(value)) return false;
  return typeof value.key === "string" && typeof value.value === "string";
}

export function encodeBackupManifest(manifest: BackupManifest): string {
  return JSON.stringify(manifest);
}

export function parseBackupManifest(json: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new BackupFormatError(
      `Backup manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isObject(parsed)) {
    throw new BackupFormatError("Backup manifest is not a JSON object.");
  }
  if (parsed.version !== BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(
      `Unsupported backup version ${String(parsed.version)}; expected ${BACKUP_FORMAT_VERSION}.`,
    );
  }
  if (typeof parsed.exportedAt !== "number") {
    throw new BackupFormatError("Backup manifest is missing exportedAt.");
  }

  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: parsed.exportedAt,
    novels: asArray(parsed.novels, "novels", isNovel).map(normalizeNovel),
    chapters: asArray(
      parsed.chapters,
      "chapters",
      isChapter,
    ).map(normalizeChapter),
    categories: asArray(parsed.categories, "categories", isCategory),
    novelCategories: asArray(
      parsed.novelCategories,
      "novelCategories",
      isNovelCategory,
    ),
    repositories: asArray(
      parsed.repositories,
      "repositories",
      isRepository,
    ),
    installedPlugins: asOptionalArray(
      parsed.installedPlugins,
      "installedPlugins",
      isInstalledPlugin,
    ),
    settings: asOptionalArray(parsed.settings, "settings", isSetting),
  };
}
