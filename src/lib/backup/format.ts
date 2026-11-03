/**
 * Backup file format.
 *
 * The on-disk artifact is a `.zip` whose entries are written and
 * read by `pack.ts` and `unpack.ts`. This module owns the envelope:
 * the JSON payload that lives in `manifest.json` inside the zip.
 * Only the current format is readable. Chapter bodies and media remain
 * in chapter storage; the archive carries their download metadata.
 *
 * The project intentionally uses its own backup format instead of
 * preserving upstream backup zip compatibility.
 */

import { isStorageId } from "../storage-id";
import type { ChapterContentType } from "../chapter-content";

export const BACKUP_FORMAT_VERSION = 5 as const;

export interface BackupNovel {
  id: number;
  sourceNovelId: string | null;
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
  /** Plugin acquisition type. */
  sourceContentType: ChapterContentType;
  /** Physical/effective type of the stored chapter body. */
  contentType: ChapterContentType;
  /** Chapter bodies remain in chapter storage. */
  content: null;
  /** Bytes of the stored chapter body. Zero when the chapter is not downloaded. */
  contentBytes: number;
  /** Bytes occupied by local chapter media files referenced by content. */
  mediaBytes: number;
  releaseTime: string | null;
  readAt: number | null;
  /** Null when the original creation time is unknown, including recovered chapters. */
  createdAt: number | null;
  foundAt: number;
  /** Inserted by a check for new chapters into a novel that already had chapters. */
  foundByCheck: boolean;
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
  /** 1 is first; a lower priority provides a plugin listed by several. */
  priority: number;
  enabled: boolean;
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
  /** The publishing repository updates come from; null when unknown. */
  repositoryUrl: string | null;
}

export interface BackupSetting {
  key: string;
  value: string;
}

export interface BackupVpnGateServerVerdict {
  ip: string;
  verdict: "works" | "fails";
  updatedAt: number;
}

/** A novel's persistent download intent, keyed by the backup's novel ID. */
export interface BackupNovelDownloadGoal {
  novelId: number;
  /** `none` is an explicit opt-out that also stops the default keep-ahead. */
  kind: "keep_ahead" | "all_remaining" | "entire" | "none";
  /** Set only for keep-ahead goals. */
  count: number | null;
  updatedAt: number;
}

export interface BackupManifest {
  version: typeof BACKUP_FORMAT_VERSION;
  /** Unix-epoch seconds when the backup was created. */
  exportedAt: number;
  novels: BackupNovel[];
  chapters: BackupChapter[];
  categories: BackupCategory[];
  novelCategories: BackupNovelCategory[];
  repositories: BackupRepository[];
  installedPlugins: BackupInstalledPlugin[];
  settings: BackupSetting[];
  vpnGateServerVerdicts: BackupVpnGateServerVerdict[];
  downloadGoals: BackupNovelDownloadGoal[];
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

function isNovel(value: unknown): value is BackupNovel {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.pluginId === "string" &&
    (value.sourceNovelId === null || isStorageId(value.sourceNovelId)) &&
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
    (value.contentType === "html" ||
      value.contentType === "pdf" ||
      value.contentType === "epub") &&
    (value.sourceContentType === "html" ||
      value.sourceContentType === "text" ||
      value.sourceContentType === "pdf" ||
      value.sourceContentType === "markdown" ||
      value.sourceContentType === "epub") &&
    value.content === null &&
    typeof value.contentBytes === "number" &&
    typeof value.mediaBytes === "number" &&
    typeof value.updatedAt === "number" &&
    (value.createdAt === null || typeof value.createdAt === "number") &&
    typeof value.foundAt === "number" &&
    typeof value.foundByCheck === "boolean"
  );
}

function normalizeNovel(novel: BackupNovel): BackupNovel {
  return {
    ...novel,
    libraryAddedAt: novel.libraryAddedAt ?? null,
    lastReadAt: novel.lastReadAt ?? null,
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
    typeof value.addedAt === "number" &&
    Number.isSafeInteger(value.priority) &&
    (value.priority as number) >= 1 &&
    typeof value.enabled === "boolean"
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
    typeof value.installedAt === "number" &&
    (value.repositoryUrl === null || typeof value.repositoryUrl === "string")
  );
}

function isSetting(value: unknown): value is BackupSetting {
  if (!isObject(value)) return false;
  return typeof value.key === "string" && typeof value.value === "string";
}

function isCanonicalIpv4(value: string): boolean {
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every(
      (octet) =>
        /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255,
    )
  );
}

function isVpnGateServerVerdict(
  value: unknown,
): value is BackupVpnGateServerVerdict {
  if (!isObject(value)) return false;
  return (
    typeof value.ip === "string" &&
    isCanonicalIpv4(value.ip) &&
    (value.verdict === "works" || value.verdict === "fails") &&
    typeof value.updatedAt === "number"
  );
}

function isNovelDownloadGoal(value: unknown): value is BackupNovelDownloadGoal {
  if (!isObject(value)) return false;
  const keepAhead = value.kind === "keep_ahead";
  return (
    Number.isSafeInteger(value.novelId) &&
    (keepAhead || value.kind === "all_remaining" || value.kind === "entire" || value.kind === "none") &&
    (keepAhead
      ? Number.isSafeInteger(value.count) && (value.count as number) > 0
      : value.count === null) &&
    Number.isSafeInteger(value.updatedAt) &&
    (value.updatedAt as number) >= 0
  );
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
  const repositories = asArray(parsed.repositories, "repositories", isRepository);
  if (new Set(repositories.map(({ url }) => url)).size !== repositories.length) {
    throw new BackupFormatError("Backup manifest lists a repository URL more than once.");
  }

  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: parsed.exportedAt,
    novels: asArray(parsed.novels, "novels", isNovel).map(normalizeNovel),
    chapters: asArray(
      parsed.chapters,
      "chapters",
      isChapter,
    ),
    categories: asArray(parsed.categories, "categories", isCategory),
    novelCategories: asArray(
      parsed.novelCategories,
      "novelCategories",
      isNovelCategory,
    ),
    repositories,
    installedPlugins: asArray(
      parsed.installedPlugins,
      "installedPlugins",
      isInstalledPlugin,
    ),
    settings: asArray(parsed.settings, "settings", isSetting),
    vpnGateServerVerdicts: asArray(
      parsed.vpnGateServerVerdicts,
      "vpnGateServerVerdicts",
      isVpnGateServerVerdict,
    ),
    downloadGoals: asArray(parsed.downloadGoals, "downloadGoals", isNovelDownloadGoal),
  };
}
