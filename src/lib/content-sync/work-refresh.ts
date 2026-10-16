import { getNovelById } from "../../db/queries/novel";
import { knownNovelMetadataDirectory, readWorkMetadataSyncFile } from "../../db/work-metadata";
import { useContentSyncStore } from "../../store/content-sync";
import { pluginManager } from "../plugins/manager";
import { syncNovelFromSource } from "../plugins/sync-novel";
import { taskScheduler } from "../tasks/scheduler";
import { enqueueSourceTask } from "../tasks/source-tasks";
import { isTauriRuntime } from "../tauri-runtime";
import { availableNovelMetadataDirectory, installStoredNovelMetadata, parseNovelMetadata, readStoredNovelCover, readStoredNovelMetadata } from "../work-metadata";
import { readServerCover } from "./browse";
import { ContentServerError, contentServerRequest, withContentServerLookup } from "./client";
import { registerContentDevice } from "./device";
import { readServerNovelSource } from "./novel-source";
import { canPullWorkMetadata, contentWorkId, recordInstalledWorkMetadata, runWorkMetadataSyncOperation, workMetadataFileVersion, workMetadataFingerprint, type WorkCatalogEntry } from "./works";
import { cacheServerChapters } from "../../db/queries/content-sync";
import { fetchServerChapters } from "./chapters";

export async function syncServerNovelOnOpen(novelId: number, signal?: AbortSignal, canApplyMetadata: () => boolean = () => true): Promise<boolean> {
  signal?.throwIfAborted();
  const settings = useContentSyncStore.getState();
  const source = await readServerNovelSource(novelId);
  const server = source?.serverUrl ?? settings.serverUrl;
  if (!server) return false;
  return runWorkMetadataSyncOperation(server, async () => {
    signal?.throwIfAborted();
    const novel = await getNovelById(novelId);
    if (!novel) return false;
    const identity = { pluginId: novel.pluginId, novelPath: novel.path };
    const directory = knownNovelMetadataDirectory(identity) ?? await availableNovelMetadataDirectory({ identity, novel });
    const stored = await readStoredNovelMetadata(directory);
    if (!stored) throw new Error("Local work metadata is missing. Rescan local files before refreshing.");
    const localCover = await readStoredNovelCover(directory, stored.metadata);
    const expected = await workMetadataFingerprint(stored.metadata, localCover);
    const file = await readWorkMetadataSyncFile(identity);
    const mayApplyMetadata = await canPullWorkMetadata(server, file, expected);
    const result = await withContentServerLookup(async deadline => {
      const token = await registerContentDevice(server, settings.deviceName, deadline);
      deadline.throwIfAborted();
      const ids = [source?.workId ?? await contentWorkId(identity)];
      for (const id of ids) {
        let entry: WorkCatalogEntry;
        try { entry = await contentServerRequest<WorkCatalogEntry>(server, `/works/${id}`, token, "GET", undefined, deadline); }
        catch (error) { if (error instanceof ContentServerError && error.status === 404) continue; throw error; }
        deadline.throwIfAborted();
        const metadata = parseNovelMetadata(entry.metadata);
        if (entry.id !== id || await contentWorkId(metadata.identity) !== id || metadata.identity.pluginId !== identity.pluginId ||
          metadata.identity.novelPath !== identity.novelPath) {
          throw new Error("Server work identity does not match the local work.");
        }
        const cover = entry.hasCover ? await readServerCover(server, token, id, deadline) : null;
        deadline.throwIfAborted();
        const chapters = await fetchServerChapters({ serverUrl: server, workId: id }, token, deadline);
        return { metadata, cover, chapters };
      }
      return null;
    }, settings.lookupTimeoutSeconds, signal);
    if (!result) return false;
    signal?.throwIfAborted();
    const local = stored.metadata;
    const remote = result.metadata;
    const metadata = { ...remote, chapters: { ...local.chapters, ...remote.chapters }, cover: result.cover ? remote.cover : local.cover };
    const coverBytes = result.cover?.bytes ?? localCover;
    let installed = false;
    if (mayApplyMetadata && await workMetadataFingerprint(metadata, coverBytes) !== expected && canApplyMetadata()) {
      const stored = await installStoredNovelMetadata(metadata, coverBytes ?? undefined, async (current, db) => {
        if (signal?.aborted || !canApplyMetadata()) return false;
        const currentFingerprint = current ? await workMetadataFingerprint(current.metadata, await readStoredNovelCover(current.directory, current.metadata)) : null;
        if (signal?.aborted || !canApplyMetadata() || currentFingerprint !== expected) return false;
        const currentFile = await readWorkMetadataSyncFile(identity, db);
        if (signal?.aborted || !canApplyMetadata() || workMetadataFileVersion(currentFile) !== workMetadataFileVersion(file)) return false;
      });
      if (stored) {
        await recordInstalledWorkMetadata(server, stored, result.cover !== null);
        installed = true;
      }
    }
    signal?.throwIfAborted();
    const chaptersChanged = await cacheServerChapters(novelId, result.chapters, signal);
    return installed || chaptersChanged;
  }, signal);
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
      { name: novel.name, path: novel.path, cover: novel.cover ?? undefined },
      { novelId, chapterRefreshMode: "full", preserveMissingMetadata: true, refreshCover: options.refreshCover ?? false, signal: context.signal }),
  });
  const abort = () => { taskScheduler.cancel(task.id); };
  signal?.addEventListener("abort", abort, { once: true });
  try { await task.promise; return true; }
  finally { signal?.removeEventListener("abort", abort); }
}
