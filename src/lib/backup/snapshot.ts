import { invoke } from "@tauri-apps/api/core";
import { getDb, runExclusiveDatabaseOperation } from "../../db/client";
import { sqliteBoolean } from "../../db/sqlite-value";
import { useReaderStore } from "../../store/reader";
import { runContentStorageOperation } from "../content-sync/storage-operation";
import {
  normalizeChapterContentType,
  storedChapterContentType,
} from "../chapter-content";
import { clearResolvedChapterStorageDirs } from "../chapter-storage-resolution";
import { invalidateAllNovelCoverSources } from "../novel-cover-storage";
import {
  BACKUP_FORMAT_VERSION,
  encodeBackupManifest,
  type BackupCategory,
  type BackupChapter,
  type BackupInstalledPlugin,
  type BackupManifest,
  type BackupNovel,
  type BackupNovelCategory,
  type BackupRepository,
  type BackupSetting,
  type BackupVpnGateServerVerdict,
} from "./format";
interface RawNovelRow {
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
  inLibrary: unknown;
  isLocal: unknown;
  createdAt: number;
  updatedAt: number;
  libraryAddedAt: number | null;
  lastReadAt: number | null;
}

const LOCAL_PLUGIN_ID = "local";

function isLocalNovel(pluginId: string, value: unknown): boolean {
  return pluginId === LOCAL_PLUGIN_ID && sqliteBoolean(value);
}

interface RawChapterRow {
  id: number;
  novelId: number;
  path: string;
  name: string;
  chapterNumber: string | null;
  position: number;
  page: string;
  bookmark: unknown;
  unread: unknown;
  progress: number;
  isDownloaded: unknown;
  sourceContentType: string;
  storedContentType: string | null;
  contentBytes: number;
  mediaBytes: number;
  releaseTime: string | null;
  readAt: number | null;
  createdAt: number;
  foundAt: number;
  updatedAt: number;
}

interface RawCategoryRow {
  id: number;
  name: string;
  sort: number;
  isSystem: number;
}

interface RawInstalledPluginRow {
  id: string;
  name: string;
  lang: string;
  version: string;
  iconUrl: string;
  sourceUrl: string;
  sourceCode: string;
  installedAt: number;
}

const BACKUP_SETTING_KEYS = new Set([
  "app-appearance-settings",
  "app-notification-settings",
  "browse-plugin-settings",
  "http-user-agent",
  "norea-library-settings",
  "reader-settings",
]);

const BACKUP_SETTING_PREFIXES = [
  "plugin-v2:",
  "source-filters:",
];
const SELECT_NOVELS = `
  SELECT
    id,
    plugin_id      AS pluginId,
    path,
    name,
    cover,
    summary,
    author,
    artist,
    status,
    genres,
    in_library     AS inLibrary,
    is_local       AS isLocal,
    created_at     AS createdAt,
    updated_at     AS updatedAt,
    library_added_at AS libraryAddedAt,
    last_read_at   AS lastReadAt
  FROM novel
  ORDER BY id
`;

const SELECT_CHAPTERS = `
  SELECT
    id,
    novel_id       AS novelId,
    path,
    name,
    chapter_number AS chapterNumber,
    position,
    page,
    bookmark,
    unread,
    progress,
    is_downloaded  AS isDownloaded,
    content_type   AS sourceContentType,
    stored_content_type AS storedContentType,
    content_bytes  AS contentBytes,
    media_bytes    AS mediaBytes,
    release_time   AS releaseTime,
    read_at        AS readAt,
    created_at     AS createdAt,
    found_at       AS foundAt,
    updated_at     AS updatedAt
  FROM chapter
  ORDER BY id
`;

const SELECT_CATEGORIES = `
  SELECT id, name, sort, is_system AS isSystem
  FROM category
  ORDER BY id
`;

const SELECT_NOVEL_CATEGORIES = `
  SELECT id, novel_id AS novelId, category_id AS categoryId
  FROM novel_category
  ORDER BY id
`;

const SELECT_REPOSITORIES = `
  SELECT id, url, name, added_at AS addedAt
  FROM repository
  ORDER BY id
`;

const SELECT_INSTALLED_PLUGINS = `
  SELECT
    id,
    name,
    lang,
    version,
    icon_url    AS iconUrl,
    source_url  AS sourceUrl,
    source_code AS sourceCode,
    installed_at AS installedAt
  FROM installed_plugin
  ORDER BY installed_at DESC, id ASC
`;

const SELECT_VPN_GATE_SERVER_VERDICTS = `
  SELECT
    ip,
    verdict,
    updated_at AS updatedAt
  FROM vpn_gate_server_verdict
  ORDER BY ip
`;

function browserLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isBackupSettingKey(key: string): boolean {
  return (
    BACKUP_SETTING_KEYS.has(key) ||
    BACKUP_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function readBackupSettings(): BackupSetting[] {
  const storage = browserLocalStorage();
  if (!storage) return [];

  const settings: BackupSetting[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !isBackupSettingKey(key)) continue;
    const value = storage.getItem(key);
    if (value !== null) settings.push({ key, value });
  }
  return settings.sort((left, right) => left.key.localeCompare(right.key));
}

function clearBackupSettings(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && isBackupSettingKey(key)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

function writeBackupSettings(settings: readonly BackupSetting[]): void {
  const storage = browserLocalStorage();
  if (!storage) return;

  clearBackupSettings(storage);
  for (const setting of settings) {
    if (isBackupSettingKey(setting.key)) {
      storage.setItem(setting.key, setting.value);
    }
  }
}

function toNovel(row: RawNovelRow): BackupNovel {
  return {
    id: row.id,
    pluginId: row.pluginId,
    path: row.path,
    name: row.name,
    cover: row.cover,
    summary: row.summary,
    author: row.author,
    artist: row.artist,
    status: row.status,
    genres: row.genres,
    inLibrary: sqliteBoolean(row.inLibrary),
    isLocal: isLocalNovel(row.pluginId, row.isLocal),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    libraryAddedAt: row.libraryAddedAt,
    lastReadAt: row.lastReadAt,
  };
}

function toChapter(row: RawChapterRow): BackupChapter {
  return {
    id: row.id,
    novelId: row.novelId,
    path: row.path,
    name: row.name,
    chapterNumber: row.chapterNumber,
    position: row.position,
    page: row.page,
    bookmark: sqliteBoolean(row.bookmark),
    unread: sqliteBoolean(row.unread),
    progress: row.progress,
    isDownloaded: sqliteBoolean(row.isDownloaded),
    sourceContentType: normalizeChapterContentType(row.sourceContentType),
    contentType: storedChapterContentType(
      normalizeChapterContentType(
        row.storedContentType ?? row.sourceContentType,
      ),
    ),
    content: null,
    contentBytes: row.contentBytes,
    mediaBytes: row.mediaBytes,
    releaseTime: row.releaseTime,
    readAt: row.readAt,
    createdAt: row.createdAt,
    foundAt: row.foundAt,
    updatedAt: row.updatedAt,
  };
}

function toCategory(row: RawCategoryRow): BackupCategory {
  return {
    id: row.id,
    name: row.name,
    sort: row.sort,
    isSystem: !!row.isSystem,
  };
}

function toInstalledPlugin(row: RawInstalledPluginRow): BackupInstalledPlugin {
  return {
    id: row.id,
    name: row.name,
    lang: row.lang,
    version: row.version,
    iconUrl: row.iconUrl,
    sourceUrl: row.sourceUrl,
    sourceCode: row.sourceCode,
    installedAt: row.installedAt,
  };
}

/**
 * Read every row from the backup-relevant tables and return a
 * fresh `BackupManifest` ready to feed `encodeBackupManifest` and
 * `packBackup`. Chapter rows carry their download flags and byte
 * counts from the database; chapter bodies and media are not read.
 */
export async function gatherBackupSnapshot(): Promise<BackupManifest> {
  const db = await getDb();
  const [
    novels,
    chapters,
    categories,
    novelCategories,
    repositories,
    installedPlugins,
    vpnGateServerVerdicts,
  ] =
    await Promise.all([
      db.select<RawNovelRow[]>(SELECT_NOVELS),
      db.select<RawChapterRow[]>(SELECT_CHAPTERS),
      db.select<RawCategoryRow[]>(SELECT_CATEGORIES),
      db.select<BackupNovelCategory[]>(SELECT_NOVEL_CATEGORIES),
      db.select<BackupRepository[]>(SELECT_REPOSITORIES),
      db.select<RawInstalledPluginRow[]>(SELECT_INSTALLED_PLUGINS),
      db.select<BackupVpnGateServerVerdict[]>(
        SELECT_VPN_GATE_SERVER_VERDICTS,
      ),
    ]);

  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: Math.floor(Date.now() / 1000),
    novels: novels.map(toNovel),
    chapters: chapters.map(toChapter),
    categories: categories.map(toCategory),
    novelCategories,
    repositories,
    installedPlugins: installedPlugins.map(toInstalledPlugin),
    settings: readBackupSettings(),
    vpnGateServerVerdicts,
  };
}

/**
 * Replace every row in the backup-relevant tables with the values
 * carried by `manifest`. Destructive; call only after the user has
 * confirmed restore. Database changes are wrapped in a transaction,
 * then browser settings are replaced after the commit succeeds.
 */
export function applyBackupSnapshot(
  manifest: BackupManifest,
): Promise<void> {
  return runContentStorageOperation(() => restoreBackupSnapshot(manifest));
}

async function restoreBackupSnapshot(manifest: BackupManifest): Promise<void> {
  clearResolvedChapterStorageDirs();
  await getDb();
  await runExclusiveDatabaseOperation(() =>
    invoke("backup_restore_snapshot", {
      manifestJson: encodeBackupManifest(manifest),
    }),
  );
  clearResolvedChapterStorageDirs();
  invalidateAllNovelCoverSources();
  writeBackupSettings(manifest.settings);
  await useReaderStore.persist.rehydrate();
}
