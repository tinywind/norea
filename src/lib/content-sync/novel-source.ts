import { isAbortError } from "../abort";
import { getChapterById } from "../../db/queries/chapter";
import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { getNovelById } from "../../db/queries/novel";
import { useContentSyncStore } from "../../store/content-sync";
import { isChapterStorageError, withChapterStorageOperation } from "../chapter-storage-error";
import { pluginManager } from "../plugins/manager";
import type { ChapterDownloadJob } from "../tasks/chapter-download";
import { ServerChapterMissingError } from "../tasks/download-failure";
import type { ChapterDownloadPhase } from "../tasks/task-types";
import { isTauriRuntime } from "../tauri-runtime";
import {
  ContentServerError,
  ContentServerTransportError,
  contentServerRequest,
  normalizeContentServerUrl,
  withContentServerLookup,
} from "./client";
import { isOtherServerChapterUnderNumber, isSameServerChapter } from "./chapter-identity";
import { registerContentDevice } from "./device";
import { hasServerMediaManifestWithoutArchive, type CatalogEntry } from "./native";
import { fetchServerChapters } from "./chapters";

export interface ServerNovelSource {
  serverUrl: string;
  workId: string;
}

export async function readServerNovelSource(novelId: number): Promise<ServerNovelSource | null> {
  const saved = await withChapterStorageOperation("read content server source", () => readContentSyncCache(`norea-content-source:${novelId}`));
  if (saved === null) return null;
  const source: unknown = JSON.parse(saved);
  if (!source || typeof source !== "object"
    || !("serverUrl" in source) || typeof source.serverUrl !== "string"
    || !("workId" in source) || typeof source.workId !== "string" || !source.workId.trim()) {
    throw new Error("Stored content server novel source is invalid.");
  }
  return { serverUrl: normalizeContentServerUrl(source.serverUrl), workId: source.workId };
}

export async function rememberServerNovelSource(novelId: number, source: ServerNovelSource): Promise<void> {
  if (!source.workId.trim()) throw new Error("Content server work ID is required.");
  const saved = JSON.stringify({ serverUrl: normalizeContentServerUrl(source.serverUrl), workId: source.workId });
  await withChapterStorageOperation("save content server source", () => writeContentSyncCache(`norea-content-source:${novelId}`, saved));
}

export async function listServerChapterAvailability(source: ServerNovelSource, signal?: AbortSignal): Promise<{ paths: Map<string, boolean>; numbers: Map<number, boolean> }> {
  const settings = useContentSyncStore.getState();
  return withContentServerLookup(async deadline => {
    const token = await registerContentDevice(source.serverUrl, settings.deviceName, deadline);
    const chapters = await fetchServerChapters(source, token, deadline).catch(error => {
      if (error instanceof ContentServerError && error.status === 404) return [];
      throw error;
    });
    const paths = new Map(chapters.map(chapter => [chapter.chapterPath, chapter.complete]));
    const numbers = new Map<number, boolean>();
    const counts = new Map<number, number>();
    for (const chapter of chapters) {
      if (chapter.chapterNumber == null || !/^\d+(?:\.\d+)?$/.test(chapter.chapterNumber)) continue;
      const number = Number(chapter.chapterNumber);
      counts.set(number, (counts.get(number) ?? 0) + 1);
      numbers.set(number, chapter.complete);
    }
    for (const [number, count] of counts) {
      if (count > 1) numbers.delete(number);
    }
    return { paths, numbers };
  }, settings.lookupTimeoutSeconds, signal);
}

/**
 * A work opened from the content server without an installed source plugin has no source to switch to
 * while it waits, so its lookup gets the ordinary request time instead of the short lookup bound.
 */
const BOUND_WORK_LOOKUP_SECONDS = 30;
const SERVER_FAILURE_COOLDOWN_MS = 30_000;
const unavailableServers = new Map<string, number>();

async function hasInstalledSourceFallback(
  novel: { isLocal?: boolean; pluginId: string; path: string },
  chapter: { compositionSource?: { pluginId: string; chapterPath: string } },
  signal?: AbortSignal,
): Promise<boolean> {
  if (chapter.compositionSource) {
    if (
      chapter.compositionSource.chapterPath.startsWith("norea-folder:") ||
      chapter.compositionSource.chapterPath.startsWith("norea-composed:")
    ) {
      return false;
    }
    if (isTauriRuntime()) {
      signal?.throwIfAborted();
      await pluginManager.loadInstalledFromDb();
      signal?.throwIfAborted();
    }
    return Boolean(pluginManager.getPlugin(chapter.compositionSource.pluginId));
  }
  if (novel.isLocal || novel.pluginId === "local" || novel.path.startsWith("norea-folder:")) {
    return false;
  }
  if (isTauriRuntime()) {
    signal?.throwIfAborted();
    await pluginManager.loadInstalledFromDb();
    signal?.throwIfAborted();
  }
  return Boolean(pluginManager.getPlugin(novel.pluginId));
}

function canFallbackLookupError(error: unknown, signal?: AbortSignal): boolean {
  return !signal?.aborted && !isAbortError(error) && !isChapterStorageError(error);
}

function canFallbackTransferError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || isAbortError(error) || isChapterStorageError(error)) {
    return false;
  }
  return (
    error instanceof ContentServerError ||
    error instanceof ContentServerTransportError ||
    (error instanceof Error && /^content sync: /.test(error.message))
  );
}

/**
 * Returns false only when no server is configured, the chapter lookup confirms its body is absent with
 * an available source plugin (or unbound work), or a failed server attempt can fall back to the source.
 * When `sourceFallback: false` or no installed plugin fallback exists for a bound server work, missing
 * server chapters throw ServerChapterMissingError and server errors propagate.
 */
export async function tryDownloadServerChapter(
  job: Pick<ChapterDownloadJob, "id" | "novelId" | "pluginId" | "chapterPath">,
  signal?: AbortSignal,
  onPhase?: (phase: ChapterDownloadPhase) => void,
  options: { sourceFallback?: boolean } = {},
): Promise<boolean> {
  signal?.throwIfAborted();
  const chapter = await withChapterStorageOperation("load server chapter", () => getChapterById(job.id));
  const novelId = chapter?.novelId ?? job.novelId;
  if (!novelId) return false;
  const source = await readServerNovelSource(novelId);
  const settings = useContentSyncStore.getState();
  const serverUrl = source?.serverUrl ?? settings.serverUrl;
  if (!serverUrl) return false;
  const novel = await withChapterStorageOperation("load server work", () => getNovelById(novelId));
  if (!chapter || !novel) throw new Error("Content server chapter no longer exists locally.");
  if (novel.pluginId !== job.pluginId || chapter.path !== job.chapterPath) {
    throw new Error("Content server download identity does not match the local chapter.");
  }
  const allowSourceFallback = options.sourceFallback !== false;
  const normalizedServer = normalizeContentServerUrl(serverUrl);
  if (allowSourceFallback && (unavailableServers.get(normalizedServer) ?? 0) > Date.now()) {
    if (await hasInstalledSourceFallback(novel, chapter, signal)) {
      return false;
    }
  }
  const target = { pluginId: novel.pluginId, novelPath: novel.path, chapterPath: chapter.path };
  const recoveredNumber = /^norea-folder:(\d+(?:\.\d+)?)$/.exec(chapter.path)?.[1];
  const number = chapter.chapterNumber ?? recoveredNumber;
  const chapterNumber = number && /^\d+(?:\.\d+)?$/.test(number) ? number : undefined;
  const query = new URLSearchParams({ ...target, ...(chapterNumber ? { chapterNumber } : {}) });
  signal?.throwIfAborted();
  onPhase?.("server-lookup");
  const serverOnlyShape =
    options.sourceFallback === false ||
    ((novel.isLocal || novel.path.startsWith("norea-folder:")) && !chapter.compositionSource);
  let found: { entry: CatalogEntry; token: string } | null;
  try {
    found = await withContentServerLookup(async deadline => {
      const token = await registerContentDevice(serverUrl, settings.deviceName, deadline);
      deadline.throwIfAborted();
      let entry: CatalogEntry;
      try {
        entry = await contentServerRequest<CatalogEntry>(serverUrl, `/catalog/chapter?${query}`, token, "GET", undefined, deadline);
      } catch (error) {
        deadline.throwIfAborted();
        if (error instanceof ContentServerError && error.status === 404) return null;
        throw error;
      }
      deadline.throwIfAborted();
      return { entry, token };
    }, source && serverOnlyShape
      ? Math.max(BOUND_WORK_LOOKUP_SECONDS, settings.lookupTimeoutSeconds ?? 3)
      : settings.lookupTimeoutSeconds ?? 3, signal);
  } catch (error) {
    if (
      allowSourceFallback &&
      canFallbackLookupError(error, signal) &&
      await hasInstalledSourceFallback(novel, chapter, signal)
    ) {
      unavailableServers.set(normalizedServer, Date.now() + SERVER_FAILURE_COOLDOWN_MS);
      return false;
    }
    throw error;
  }
  unavailableServers.delete(normalizedServer);
  const requested = { chapterPath: chapter.path, chapterNumber };
  const remoteIdentity = (value: CatalogEntry) => ({ chapterPath: value.manifest.identity.chapterPath, chapterNumber: value.manifest.chapter?.chapterNumber });
  if (found && isOtherServerChapterUnderNumber(remoteIdentity(found.entry), requested)) found = null;
  if (!found) {
    if (source && (!allowSourceFallback || !(await hasInstalledSourceFallback(novel, chapter, signal)))) {
      throw new ServerChapterMissingError();
    }
    return false;
  }
  const { entry, token } = found;
  const identity = entry.manifest.identity;
  const sameWork = identity.novelPath === novel.path;
  if (entry.deleted || identity.pluginId !== novel.pluginId || !sameWork || !isSameServerChapter(remoteIdentity(entry), requested)) {
    throw new Error("Content server download identity does not match the requested chapter.");
  }
  if (
    entry.complete === false &&
    allowSourceFallback &&
    hasServerMediaManifestWithoutArchive(entry) &&
    await hasInstalledSourceFallback(novel, chapter, signal)
  ) {
    return false;
  }
  signal?.throwIfAborted();
  const { downloadServerChapterFromServer } = await import("./sync");
  signal?.throwIfAborted();
  onPhase?.("server-download");
  try {
    await downloadServerChapterFromServer(entry, serverUrl, { token, target, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (
      allowSourceFallback &&
      canFallbackTransferError(error, signal) &&
      await hasInstalledSourceFallback(novel, chapter, signal)
    ) {
      unavailableServers.set(normalizedServer, Date.now() + SERVER_FAILURE_COOLDOWN_MS);
      return false;
    }
    throw error;
  }
  return true;
}
