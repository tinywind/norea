import { parseChapterComposition } from "../chapter-composition";
import { invoke } from "@tauri-apps/api/core";
import { cancelWorkMetadataRecovery } from "../../db/client";
import { invokeDbQuery } from "../../db/ipc";
import { restoreWorkMetadataDirectoriesFromRust } from "../../db/work-metadata";
import { emitUserStateLedgerChanged } from "../../db/user-state-core";
import { DOWNLOAD_GOAL_SETTINGS_KEY, useDownloadGoalSettingsStore } from "../../store/download-goals";
import { DOWNLOAD_RECOVERY_SETTINGS_KEY, useDownloadRecoveryStore } from "../../store/download-recovery";
import { useReaderStore } from "../../store/reader";
import { runContentStorageOperation } from "../content-sync/storage-operation";
import { withUserStateRestore } from "../user-state/maintenance";
import {
  normalizeChapterContentType,
  storedChapterContentType,
} from "../chapter-content";
import { clearResolvedChapterStorageDirs } from "../chapter-storage-resolution";
import { invalidateAllNovelCoverSources } from "../novel-cover-storage";
import { notifyWorkMetadataChanges } from "../work-metadata";
import { prepareBackupRestore } from "./restore-plan";
import {
  BACKUP_FORMAT_VERSION,
  encodeBackupManifest,
  parseBackupNovelOverride,
  type BackupCategory,
  type BackupChapter,
  type BackupInstalledPlugin,
  type BackupManifest,
  type BackupNovel,
  type BackupNovelCategory,
  type BackupNovelDownloadGoal,
  type BackupRepository,
  type BackupSetting,
  type BackupVpnGateServerVerdict,
} from "./format";

interface GatheredNovelDto {
  chapterCompositionPayload?: string | null;
  overridePayload?: string | null;
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

interface GatheredChapterDto {
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
  sourceContentType: string;
  storedContentType: string | null;
  contentBytes: number;
  mediaBytes: number;
  releaseTime: string | null;
  readAt: number | null;
  createdAt: number | null;
  foundAt: number;
  foundByCheck: boolean;
  updatedAt: number;
}

interface GatheredSnapshotDto {
  novels: GatheredNovelDto[];
  chapters: GatheredChapterDto[];
  categories: BackupCategory[];
  novelCategories: BackupNovelCategory[];
  repositories: BackupRepository[];
  installedPlugins: BackupInstalledPlugin[];
  vpnGateServerVerdicts: BackupVpnGateServerVerdict[];
  downloadGoals: BackupNovelDownloadGoal[];
}

const LOCAL_PLUGIN_ID = "local";

const BACKUP_SETTING_KEYS = new Set([
  "app-appearance-settings",
  "app-notification-settings",
  "browse-plugin-settings",
  DOWNLOAD_GOAL_SETTINGS_KEY,
  DOWNLOAD_RECOVERY_SETTINGS_KEY,
  "http-user-agent",
  "norea-library-settings",
  "reader-settings",
]);

const BACKUP_SETTING_PREFIXES = [
  "plugin-v2:",
  "source-filters:",
];

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

function toNovel(row: GatheredNovelDto): BackupNovel {
  const override = row.overridePayload
    ? parseBackupNovelOverride(JSON.parse(row.overridePayload))
    : undefined;
  return {
    ...(row.chapterCompositionPayload
      ? { chapterComposition: parseChapterComposition(JSON.parse(row.chapterCompositionPayload)) }
      : {}),
    ...(override ? { override } : {}),
    id: row.id,
    pluginId: row.pluginId,
    sourceNovelId: row.sourceNovelId,
    path: row.path,
    name: row.name,
    cover: row.cover,
    summary: row.summary,
    author: row.author,
    artist: row.artist,
    status: row.status,
    genres: row.genres,
    inLibrary: Boolean(row.inLibrary),
    isLocal: row.pluginId === LOCAL_PLUGIN_ID && Boolean(row.isLocal),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    libraryAddedAt: row.libraryAddedAt,
    lastReadAt: row.lastReadAt,
  };
}

function toChapter(row: GatheredChapterDto): BackupChapter {
  return {
    id: row.id,
    novelId: row.novelId,
    path: row.path,
    name: row.name,
    chapterNumber: row.chapterNumber,
    position: row.position,
    page: row.page,
    bookmark: Boolean(row.bookmark),
    unread: Boolean(row.unread),
    progress: row.progress,
    isDownloaded: Boolean(row.isDownloaded),
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
    foundByCheck: Boolean(row.foundByCheck),
    updatedAt: row.updatedAt,
  };
}

/**
 * Read every row from the backup-relevant tables via a single native
 * transaction and return a fresh `BackupManifest` ready to feed
 * `encodeBackupManifest` and `packBackup`. Chapter rows carry their
 * download flags and byte counts from the database; chapter bodies and
 * media are not read.
 */
export async function gatherBackupSnapshot(): Promise<BackupManifest> {
  const snapshot = await invokeDbQuery<GatheredSnapshotDto>("backup_gather_snapshot");

  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: Math.floor(Date.now() / 1000),
    novels: snapshot.novels.map(toNovel),
    chapters: snapshot.chapters.map(toChapter),
    categories: snapshot.categories.map((category) => ({
      id: category.id,
      name: category.name,
      sort: category.sort,
      isSystem: Boolean(category.isSystem),
      ...(category.stableId ? { stableId: category.stableId } : {}),
    })),
    novelCategories: snapshot.novelCategories,
    repositories: snapshot.repositories.map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
    })),
    installedPlugins: snapshot.installedPlugins,
    settings: readBackupSettings(),
    vpnGateServerVerdicts: snapshot.vpnGateServerVerdicts,
    downloadGoals: snapshot.downloadGoals,
  };
}

/**
 * Replace every row in the backup-relevant tables with the values
 * carried by `manifest`, while existing files supply authoritative metadata
 * and download availability. File inspection precedes the native transaction;
 * originals are never changed. Settings are replaced after commit succeeds.
 */
export function applyBackupSnapshot(
  manifest: BackupManifest,
): Promise<void> {
  return withUserStateRestore(() => runContentStorageOperation(() => restoreBackupSnapshot(manifest)));
}

async function restoreBackupSnapshot(manifest: BackupManifest): Promise<void> {
  clearResolvedChapterStorageDirs();
  cancelWorkMetadataRecovery();
  const plan = await prepareBackupRestore(manifest);
  await invoke("backup_restore_snapshot", {
    manifestJson: encodeBackupManifest(plan.manifest),
    cacheJson: JSON.stringify(plan.cache),
  });
  emitUserStateLedgerChanged();
  await restoreWorkMetadataDirectoriesFromRust(true);
  clearResolvedChapterStorageDirs();
  invalidateAllNovelCoverSources();
  writeBackupSettings(manifest.settings);
  await useReaderStore.persist.rehydrate();
  await useDownloadGoalSettingsStore.persist.rehydrate();
  await useDownloadRecoveryStore.persist.rehydrate();
  notifyWorkMetadataChanges();
}
