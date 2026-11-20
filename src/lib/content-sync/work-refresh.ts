import { getNovelById } from "../../db/queries/novel";
import { knownNovelMetadataDirectory, readWorkMetadataSyncFile } from "../../db/work-metadata";
import { useContentSyncStore } from "../../store/content-sync";
import { pluginManager } from "../plugins/manager";
import { syncNovelFromSource } from "../plugins/sync-novel";
import { taskScheduler } from "../tasks/scheduler";
import { enqueueSourceTask } from "../tasks/source-tasks";
import { isTauriRuntime } from "../tauri-runtime";
import { mergeIncomingNovelMetadata } from "../work-metadata/merge";
import { availableNovelMetadataDirectory, installStoredNovelMetadata, parseNovelMetadata, readStoredNovelCover, readStoredNovelMetadata, type StoredNovelMetadata } from "../work-metadata";
import { readServerCover, refreshServerNovel } from "./browse";
import { ContentServerError, contentServerRequest, withContentServerLookup } from "./client";
import { registerContentDevice } from "./device";
import { serverWorkDeletionKey, withServerWorkDeletionExclusions, waitForServerWorkDeletion } from "./deletion-exclusions";
import { readServerNovelSource } from "./novel-source";
import { canPullWorkMetadata, contentWorkId, recordInstalledWorkMetadata, runWorkMetadataSyncOperation, workMetadataFileVersion, workMetadataFingerprint, workResponseETag, type WorkCatalogEntry } from "./works";
import { cacheServerChapters, isNovelMigrationSourceHeld } from "../../db/queries/content-sync";
import { fetchServerChapters } from "./chapters";

export async function syncServerNovelOnOpen(novelId: number, signal?: AbortSignal, canApplyMetadata: () => boolean = () => true, timeoutSeconds?: number): Promise<boolean> {
  signal?.throwIfAborted();
  const settings = useContentSyncStore.getState();
  const source = await readServerNovelSource(novelId);
  const server = source?.serverUrl ?? settings.serverUrl;
  if (!server) return false;
  const refreshed = await runWorkMetadataSyncOperation(server, () => withServerWorkDeletionExclusions(server, async excluded => {
    signal?.throwIfAborted();
    const novel = await getNovelById(novelId);
    if (!novel) return false;
    const identity = { pluginId: novel.pluginId, novelId: novel.sourceNovelId!, novelPath: novel.path };
    const isDeleted = () => excluded.has(serverWorkDeletionKey(identity));
    if (isDeleted()) return false;
    if (await isNovelMigrationSourceHeld(server, identity)) return false;
    const directory = knownNovelMetadataDirectory(identity) ?? await availableNovelMetadataDirectory({ identity, novel });
    const stored = await readStoredNovelMetadata(directory);
    // Removing a work's files from this device also removes its metadata and cover; the server still has them.
    if (!stored && source) return "metadata-missing" as const;
    if (!stored) throw new Error("Local work metadata is missing. Rescan local files before refreshing.");
    const localCover = await readStoredNovelCover(directory, stored.metadata);
    const expected = await workMetadataFingerprint(stored.metadata, localCover);
    const file = await readWorkMetadataSyncFile(identity);
    const mayApplyMetadata = await canPullWorkMetadata(server, file, expected);
    const workId = source?.workId ?? await contentWorkId(identity);
    const etag = await workResponseETag(stored.metadata, localCover);
    const result = await withContentServerLookup(async deadline => {
      const token = await registerContentDevice(server, settings.deviceName, deadline);
      deadline.throwIfAborted();
      let entry: WorkCatalogEntry | undefined;
      try {
        entry = await contentServerRequest<WorkCatalogEntry | undefined>(server, `/works/${workId}`, token, "GET", undefined, deadline, 30,
          { headers: { "If-None-Match": etag }, acceptNotModified: true });
      } catch (error) {
        if (error instanceof ContentServerError && error.status === 404) return null;
        throw error;
      }
      deadline.throwIfAborted();
      const metadata = entry ? parseNovelMetadata(entry.metadata) : stored.metadata;
      if (await contentWorkId(metadata.identity) !== workId || (entry && entry.id !== workId) ||
          metadata.identity.pluginId !== identity.pluginId || metadata.identity.novelPath !== identity.novelPath) {
        throw new Error("Server work identity does not match the local work.");
      }
      const cover = entry?.hasCover ? await readServerCover(server, token, workId, deadline) : null;
      deadline.throwIfAborted();
      const chapters = await fetchServerChapters({ serverUrl: server, workId }, token, deadline);
      return { entry, metadata, cover, chapters, token };
    }, timeoutSeconds ?? settings.lookupTimeoutSeconds, signal);
    await waitForServerWorkDeletion(server, workId);
    if (!result || isDeleted()) return false;
    signal?.throwIfAborted();
    if (!result.entry) return cacheServerChapters(novelId, result.chapters, signal);
    const local = stored.metadata;
    const remote = result.metadata;
    const reconciliation = Object.keys(local.chapters).some(number => !Object.hasOwn(remote.chapters, number))
      ? await (await import("./incoming-chapter-number-reconciliation")).prepareIncomingChapterNumberReconciliation(
        server, result.token, result.entry, local, () => {
          signal?.throwIfAborted();
          if (isDeleted() || !canApplyMetadata()) throw new Error("The work changed before incoming chapter numbers could be applied.");
        }, { allowUnmappedLocalAdditions: !mayApplyMetadata })
      : undefined;
    const metadata = { ...mergeIncomingNovelMetadata(reconciliation?.previousMetadata ?? local, remote), cover: result.cover ? remote.cover : local.cover };
    const coverBytes = result.cover?.bytes ?? localCover;
    const beforeInstall = async (current: StoredNovelMetadata | null) => {
      if (await isNovelMigrationSourceHeld(server, identity)) return false;
      if (isDeleted() || signal?.aborted || !canApplyMetadata()) return false;
      const currentFingerprint = current ? await workMetadataFingerprint(current.metadata, await readStoredNovelCover(current.directory, current.metadata)) : null;
      if (isDeleted() || signal?.aborted || !canApplyMetadata() || currentFingerprint !== expected) return false;
      const currentFile = await readWorkMetadataSyncFile(identity);
      if (isDeleted() || signal?.aborted || !canApplyMetadata() || workMetadataFileVersion(currentFile) !== workMetadataFileVersion(file)) return false;
    };
    let installed = false;
    if (reconciliation && !mayApplyMetadata && canApplyMetadata()) {
      const storedReconciled = await reconciliation.install(reconciliation.renumberedLocalMetadata, undefined, beforeInstall);
      if (storedReconciled) {
        installed = true;
      }
    } else if (mayApplyMetadata && await workMetadataFingerprint(metadata, coverBytes) !== expected && canApplyMetadata()) {
      const install = reconciliation?.install ?? installStoredNovelMetadata;
      const stored = await install(metadata, coverBytes ?? undefined, beforeInstall);
      if (stored) {
        await recordInstalledWorkMetadata(server, stored, result.cover !== null);
        installed = true;
      }
    }
    signal?.throwIfAborted();
    if (isDeleted()) return false;
    if (reconciliation && !installed) return false;
    const chaptersChanged = await cacheServerChapters(novelId, result.chapters, signal);
    return installed || chaptersChanged;
  }), signal);
  if (refreshed !== "metadata-missing") return refreshed;
  signal?.throwIfAborted();
  await refreshServerNovel(source!);
  return true;
}

interface ServerNovelSourceRefreshOptions {
  priority?: "deferred" | "user";
  refreshCover?: boolean;
}

export async function refreshServerNovelFromSource(novelId: number, title: string, signal?: AbortSignal, options: ServerNovelSourceRefreshOptions = {}): Promise<boolean> {
  signal?.throwIfAborted();
  if (!await readServerNovelSource(novelId)) return false;
  const novel = await getNovelById(novelId);
  if (!novel || novel.isLocal || novel.path.startsWith("norea-folder:")) return false;
  if (isTauriRuntime()) await pluginManager.loadInstalledFromDb();
  const plugin = pluginManager.getPlugin(novel.pluginId);
  if (!plugin) return false;
  signal?.throwIfAborted();
  const task = enqueueSourceTask({
    plugin, kind: "source.refreshNovel", priority: options.priority ?? "deferred", title,
    subject: { novelId, novelName: novel.name, path: novel.path },
    dedupeKey: `source.refreshNovel:${options.refreshCover ? "explicit" : "on-open"}:${novel.pluginId}:${novel.path}`,
    run: context => syncNovelFromSource(pluginManager.getPluginForExecutor(novel.pluginId, context.executor ?? "immediate"),
      { name: novel.sourceMetadata?.name ?? novel.name, path: novel.path, cover: novel.cover ?? undefined },
      { novelId, chapterRefreshMode: "full", preserveMissingMetadata: true, refreshCover: options.refreshCover ?? false, signal: context.signal }),
  });
  const abort = () => { taskScheduler.cancel(task.id); };
  signal?.addEventListener("abort", abort, { once: true });
  try { await task.promise; return true; }
  finally { signal?.removeEventListener("abort", abort); }
}
