import { useContentSyncStore } from "../../store/content-sync";
import type { NovelMetadataV1 } from "../work-metadata";
import { fetchServerChapterPage } from "./chapters";
import { ContentServerError, contentServerRequest, normalizeContentServerUrl, withContentServerLookup } from "./client";
import { registerContentDevice } from "./device";
import { runServerWorkDeletion } from "./deletion-exclusions";
import type { ServerNovelSource } from "./novel-source";
import { contentWorkId, recordDeletedWorkMetadata, type WorkCatalogEntry } from "./works";

export async function findServerWork(serverUrl: string, identity: Pick<NovelMetadataV1["identity"], "pluginId" | "novelPath"> & { novelId?: string | null }, signal?: AbortSignal): Promise<ServerNovelSource | null> {
  const settings = useContentSyncStore.getState();
  return withContentServerLookup(async deadline => {
    const workId = await contentWorkId(identity);
    const token = await registerContentDevice(serverUrl, settings.deviceName, deadline);
    try {
      const work = await contentServerRequest<WorkCatalogEntry>(serverUrl, `/works/${workId}`, token, "GET", undefined, deadline);
      deadline.throwIfAborted();
      if (work.deleted) return null;
      if (work.id !== workId || work.metadata.identity.pluginId !== identity.pluginId || work.metadata.identity.novelPath !== identity.novelPath || (identity.novelId != null && work.metadata.identity.novelId !== identity.novelId)) {
        throw new Error("Server work identity does not match the requested work.");
      }
      return { serverUrl, workId };
    } catch (error) {
      if (error instanceof ContentServerError && error.status === 404) return null;
      throw error;
    }
  }, settings.lookupTimeoutSeconds, signal);
}

export async function loadServerChapterPage(source: ServerNovelSource, offset: number, signal?: AbortSignal) {
  const token = await registerContentDevice(source.serverUrl, useContentSyncStore.getState().deviceName, signal);
  signal?.throwIfAborted();
  return fetchServerChapterPage(source, token, offset, signal);
}

export async function deleteSelectedServerChapters(source: Pick<ServerNovelSource, "serverUrl">, chapterIds: readonly string[]): Promise<void> {
  if (!chapterIds.length) return;
  const token = await registerContentDevice(source.serverUrl, useContentSyncStore.getState().deviceName);
  for (const id of new Set(chapterIds)) {
    try { await contentServerRequest(source.serverUrl, `/chapters/${encodeURIComponent(id)}`, token, "DELETE"); }
    catch (error) { if (!(error instanceof ContentServerError && error.status === 404)) throw error; }
  }
}

export async function deleteServerWork(source: ServerNovelSource, onDeleted?: (entry: WorkCatalogEntry) => void): Promise<WorkCatalogEntry> {
  const server = normalizeContentServerUrl(source.serverUrl);
  return runServerWorkDeletion(server, source.workId, async () => {
    const token = await registerContentDevice(server, useContentSyncStore.getState().deviceName);
    const entry = await contentServerRequest<WorkCatalogEntry>(server, `/works/${encodeURIComponent(source.workId)}`, token, "DELETE");
    if (entry.id !== source.workId || !entry.deleted) throw new Error("Server did not confirm the requested work deletion.");
    onDeleted?.(entry);
    await recordDeletedWorkMetadata(server, entry);
    return entry;
  });
}
