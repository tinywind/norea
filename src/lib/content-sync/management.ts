import { useContentSyncStore } from "../../store/content-sync";
import type { NovelMetadataV1 } from "../work-metadata";
import type { ServerWorkSummary } from "./browse";
import { fetchServerChapterPage } from "./chapters";
import { ContentServerError, contentServerRequest, normalizeContentServerUrl, withContentServerLookup } from "./client";
import { forgetContentServerCapabilities, getContentServerCapabilities, registerContentDevice } from "./device";
import { runServerWorkDeletion } from "./deletion-exclusions";
import type { ServerNovelSource } from "./novel-source";
import { contentWorkId, recordDeletedWorkMetadata, type WorkCatalogEntry } from "./works";

export type ExpectedWorkIdentity = Pick<NovelMetadataV1["identity"], "pluginId" | "novelPath"> & { novelId?: string | null };
const conditionalDeleteContentType = "application/vnd.norea.work-identity-delete+json";
const matchesIdentity = (actual: NovelMetadataV1["identity"], expected: ExpectedWorkIdentity) =>
  actual.pluginId === expected.pluginId && actual.novelPath === expected.novelPath &&
  (expected.novelId == null || actual.novelId === expected.novelId);

export async function loadServerWorkIdentity(source: ServerNovelSource, token: string, signal?: AbortSignal): Promise<NovelMetadataV1["identity"] | null> {
  const id = encodeURIComponent(source.workId);
  const capabilities = await getContentServerCapabilities(source.serverUrl, signal);
  try {
    if (capabilities.workCatalogSummaryVersion === 1) {
      const work = await contentServerRequest<ServerWorkSummary>(source.serverUrl, `/catalog/works/${id}`, token, "GET", undefined, signal);
      if (work.id !== source.workId) throw new Error("Server work identity does not match the requested work.");
      return work.identity;
    }
    const work = await contentServerRequest<WorkCatalogEntry>(source.serverUrl, `/works/${id}`, token, "GET", undefined, signal);
    if (work.id !== source.workId) throw new Error("Server work identity does not match the requested work.");
    return work.deleted ? null : work.metadata.identity;
  } catch (error) {
    if (error instanceof ContentServerError && error.status === 404) return null;
    throw error;
  }
}

export async function findServerWork(serverUrl: string, identity: ExpectedWorkIdentity, signal?: AbortSignal, options?: { timeoutSeconds?: number }): Promise<ServerNovelSource | null> {
  const settings = useContentSyncStore.getState();
  return withContentServerLookup(async deadline => {
    const workId = await contentWorkId(identity);
    const token = await registerContentDevice(serverUrl, settings.deviceName, deadline);
    const source = { serverUrl, workId };
    const actual = await loadServerWorkIdentity(source, token, deadline);
    deadline.throwIfAborted();
    if (!actual) return null;
    if (!matchesIdentity(actual, identity)) throw new Error("Server work identity does not match the requested work.");
    return source;
  }, options?.timeoutSeconds ?? settings.lookupTimeoutSeconds, signal);
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

export async function deleteServerWork(source: ServerNovelSource, onDeleted?: (entry: WorkCatalogEntry) => void, expectedIdentity?: ExpectedWorkIdentity): Promise<WorkCatalogEntry | null> {
  const server = normalizeContentServerUrl(source.serverUrl);
  return runServerWorkDeletion(server, source.workId, async () => {
    const settings = useContentSyncStore.getState();
    const token = await registerContentDevice(server, settings.deviceName);
    const path = `/works/${encodeURIComponent(source.workId)}`;
    const deleteLegacy = async () => {
      if (expectedIdentity) {
        const verified = await findServerWork(server, expectedIdentity, undefined, { timeoutSeconds: Math.max(30, settings.lookupTimeoutSeconds) });
        if (!verified) return null;
        if (verified.workId !== source.workId) throw new Error("Server work identity does not match the requested work.");
      }
      return contentServerRequest<WorkCatalogEntry>(server, path, token, "DELETE");
    };
    let entry: WorkCatalogEntry | null;
    try {
      if (expectedIdentity && (await getContentServerCapabilities(server)).workDeleteIdentityCheckVersion === 1) {
        const query = new URLSearchParams({ pluginId: expectedIdentity.pluginId, novelPath: expectedIdentity.novelPath });
        if (expectedIdentity.novelId != null) query.set("novelId", expectedIdentity.novelId);
        try {
          entry = await contentServerRequest<WorkCatalogEntry>(server, `${path}?${query}`, token, "DELETE", {}, undefined, 30,
            { headers: { "Content-Type": conditionalDeleteContentType } });
        } catch (error) {
          if (!(error instanceof ContentServerError && error.status === 415)) throw error;
          // An older server rejects the versioned media type even if it ignores the query parameters.
          forgetContentServerCapabilities(server);
          entry = await deleteLegacy();
        }
      } else {
        entry = await deleteLegacy();
      }
    } catch (error) {
      if (expectedIdentity && error instanceof ContentServerError && error.status === 404) return null;
      if (error instanceof ContentServerError && error.status === 409 && error.serverCode === "work-identity-mismatch") {
        throw new Error("Server work identity does not match the requested work.", { cause: error });
      }
      throw error;
    }
    if (!entry) return null;
    if (entry.id !== source.workId || !entry.deleted) throw new Error("Server did not confirm the requested work deletion.");
    if (expectedIdentity && !matchesIdentity(entry.metadata.identity, expectedIdentity)) {
      throw new Error("Server work identity does not match the requested work.");
    }
    onDeleted?.(entry);
    await recordDeletedWorkMetadata(server, entry);
    return entry;
  });
}
