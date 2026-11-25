import { isTauriRuntime } from "../lib/tauri-runtime";
import {
  clearAuthoritativeStorageDirs,
  rememberAuthoritativeChapterStorageDir,
  rememberResolvedNovelStorageDir,
  resolvedNovelStorageDir,
} from "../lib/chapter-storage-resolution";
import {
  listStoredNovelChapters,
  listStoredNovelMetadata,
  parseNovelMetadata,
  type NovelMetadataV1,
} from "../lib/work-metadata";
import { runWorkContentStorageOperation } from "../lib/content-sync/storage-operation";
import {
  currentChapterDownloadRevision,
  listIneligibleSnapshotChapterIds,
} from "../lib/chapter-download-writes";
import { invokeDbMutation, invokeDbQuery } from "./ipc";

export interface KnownMetadataFile {
  directory: string;
  fingerprint: string;
}

export interface WorkMetadataSyncFile extends KnownMetadataFile {
  pluginId: string;
  path: string;
  revision: number;
  /** True when the work is in the library or has locally stored chapter content. */
  uploadEligible?: boolean;
}

export interface WorkMetadataRecoveryProgress {
  totalWorks: number;
  completedWorks: number;
  recoveredWorks: number;
  recoveredChapters: number;
  skippedWorks: number;
  currentWork: string | null;
}

const knownFiles = new Map<string, KnownMetadataFile>();
const keyFor = (pluginId: string, path: string) =>
  JSON.stringify([pluginId, path]);

export function rememberKnownNovelMetadataFile(
  pluginId: string,
  novelPath: string,
  directory: string,
  fingerprint: string,
): void {
  knownFiles.set(keyFor(pluginId, novelPath), { directory, fingerprint });
}

export function getKnownNovelMetadataFile(
  pluginId: string,
  novelPath: string,
): KnownMetadataFile | undefined {
  return knownFiles.get(keyFor(pluginId, novelPath));
}

export function snapshotKnownNovelMetadataFiles(): Map<
  string,
  KnownMetadataFile
> {
  return new Map(knownFiles);
}

export function restoreKnownNovelMetadataFiles(
  snapshot: ReadonlyMap<string, KnownMetadataFile>,
): void {
  knownFiles.clear();
  for (const [key, value] of snapshot) {
    knownFiles.set(key, value);
  }
}

export function knownNovelMetadataDirectory(
  identity: Pick<NovelMetadataV1["identity"], "pluginId" | "novelPath">,
): string | undefined {
  return knownFiles.get(keyFor(identity.pluginId, identity.novelPath))
    ?.directory;
}

/** Forget the authoritative file after an explicit whole-work folder deletion. */
export function forgetNovelMetadataFile(
  pluginId: string,
  novelPath: string,
): void {
  knownFiles.delete(keyFor(pluginId, novelPath));
}

export async function storedNovelMetadataFingerprint(
  metadata: NovelMetadataV1,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parseNovelMetadata(metadata))),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function hasWorkMetadataConflict(
  directory: string,
  metadata: NovelMetadataV1,
): Promise<boolean> {
  const known = knownFiles.get(
    keyFor(metadata.identity.pluginId, metadata.identity.novelPath),
  );
  return Boolean(
    known &&
      (known.directory !== directory ||
        known.fingerprint !== (await storedNovelMetadataFingerprint(metadata))),
  );
}

export async function refreshStoredNovelChapterDownloads(
  novelId: number,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const directory = await invokeDbQuery<string | null>(
    "db_work_metadata_get_work_directory",
    {
      novelId,
      readMode: "queued",
    },
  );
  if (!directory) return;
  const downloadRevision = currentChapterDownloadRevision();
  rememberResolvedNovelStorageDir(novelId, directory);
  const chapters = await listStoredNovelChapters(directory);
  const skippedChapterIds = listIneligibleSnapshotChapterIds(downloadRevision);
  await invokeDbMutation("db_work_metadata_apply_scanned_downloads", {
    novelId,
    directory,
    chapters,
    skippedChapterIds,
  });
}

export async function restoreWorkMetadataDirectoriesFromRust(
  registerNative = false,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const { files, chapters } = await invokeDbQuery<{
    files: Array<{
      pluginId: string;
      path: string;
      novelId: number;
      directory: string;
      fingerprint: string;
    }>;
    chapters: Array<{ id: number; directory: string }>;
  }>("db_work_metadata_restore_directories", {
    registerNative,
    readMode: "queued",
  });
  const changedFiles = files.filter(
    (file) => resolvedNovelStorageDir(file.novelId) !== file.directory,
  );
  knownFiles.clear();
  clearAuthoritativeStorageDirs();
  for (const file of files) {
    knownFiles.set(keyFor(file.pluginId, file.path), {
      directory: file.directory,
      fingerprint: file.fingerprint,
    });
    rememberResolvedNovelStorageDir(file.novelId, file.directory);
  }
  for (const chapter of chapters) {
    rememberAuthoritativeChapterStorageDir(chapter.id, chapter.directory);
  }
  if (changedFiles.length) {
    const { notifyNovelCoverChanged } = await import(
      "../lib/novel-cover-storage"
    );
    for (const file of changedFiles) {
      notifyNovelCoverChanged(file.novelId, {
        pluginId: file.pluginId,
        path: file.path,
      });
    }
  }
}

export async function flushPendingWorkMetadata(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeDbMutation("db_work_metadata_flush_pending");
}

export async function readWorkMetadataSyncFiles(
  rescan = false,
): Promise<WorkMetadataSyncFile[]> {
  if (!isTauriRuntime()) return [];
  if (rescan) {
    await flushPendingWorkMetadata();
    const entries = await listStoredNovelMetadata();
    for (const entry of entries) {
      await runWorkContentStorageOperation(
        entry.metadata.identity.pluginId,
        entry.metadata.identity.novelPath,
        async () => {
          const downloadRevision = currentChapterDownloadRevision();
          const chapters = await listStoredNovelChapters(entry.directory);
          const skippedChapterIds =
            listIneligibleSnapshotChapterIds(downloadRevision);
          await invokeDbMutation("db_work_metadata_rescan_work", {
            directory: entry.directory,
            chapters,
            skippedChapterIds,
          });
        },
      );
    }
  }
  return invokeDbMutation<WorkMetadataSyncFile[]>(
    "db_work_metadata_read_sync_files",
  );
}

export async function readWorkMetadataSyncFile(
  identity: Pick<NovelMetadataV1["identity"], "pluginId" | "novelPath">,
): Promise<WorkMetadataSyncFile | null> {
  if (!isTauriRuntime()) return null;
  return invokeDbQuery<WorkMetadataSyncFile | null>(
    "db_work_metadata_read_sync_file",
    {
      pluginId: identity.pluginId,
      novelPath: identity.novelPath,
      readMode: "queued",
    },
  );
}

export async function reindexPreservedWorkMetadata(
  directory: string,
  metadata: NovelMetadataV1,
): Promise<number> {
  return invokeDbMutation<number>("db_work_metadata_reindex_preserved_work", {
    input: { directory, metadata: parseNovelMetadata(metadata) },
  });
}
