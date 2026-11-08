import { getChapterById } from "../../db/queries/chapter";
import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { getNovelById } from "../../db/queries/novel";
import { useContentSyncStore } from "../../store/content-sync";
import { withChapterStorageOperation } from "../chapter-storage-error";
import type { ChapterDownloadJob } from "../tasks/chapter-download";
import type { ChapterDownloadPhase } from "../tasks/task-types";
import { pluginManager } from "../plugins/manager";
import { ContentServerError, contentServerRequest, normalizeContentServerUrl, withContentServerLookup } from "./client";
import { registerContentDevice } from "./device";
import type { CatalogEntry } from "./native";
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
    const chapters = await fetchServerChapters(source, token, deadline);
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

export async function tryDownloadServerChapter(
  job: Pick<ChapterDownloadJob, "id" | "novelId" | "pluginId" | "chapterPath">,
  signal?: AbortSignal,
  onPhase?: (phase: ChapterDownloadPhase) => void,
  options: { requireComplete?: boolean; serverOnly?: boolean } = {},
): Promise<boolean> {
  signal?.throwIfAborted();
  const chapter = await withChapterStorageOperation("load server chapter", () => getChapterById(job.id));
  const novelId = chapter?.novelId ?? job.novelId;
  if (!novelId) {
    if (options.serverOnly) throw new Error("Content server chapter no longer exists locally.");
    return false;
  }
  const source = await readServerNovelSource(novelId);
  const settings = useContentSyncStore.getState();
  const serverUrl = source?.serverUrl ?? settings.serverUrl;
  if (!serverUrl) {
    if (options.serverOnly) throw new Error("Content server is not configured for this work.");
    return false;
  }
  const novel = await withChapterStorageOperation("load server work", () => getNovelById(novelId));
  if (!chapter || !novel) throw new Error("Content server chapter no longer exists locally.");
  if (novel.pluginId !== job.pluginId || chapter.path !== job.chapterPath) {
    throw new Error("Content server download identity does not match the local chapter.");
  }
  const canUseSourceFallback = async () => {
    if (options.serverOnly || novel.isLocal || novel.path.startsWith("norea-folder:")) return false;
    if (!source && !chapter.path.startsWith("norea-folder:")) return true;
    if (!pluginManager.getPlugin(novel.pluginId)) {
      await pluginManager.loadInstalledFromDb();
      signal?.throwIfAborted();
    }
    return Boolean(pluginManager.getPlugin(novel.pluginId));
  };
  const target = { pluginId: novel.pluginId, novelPath: novel.path, chapterPath: chapter.path };
  const number = chapter.chapterNumber ?? (chapter.position > 0 ? String(chapter.position) : undefined);
  const chapterNumber = number && /^\d+(?:\.\d+)?$/.test(number) ? number : undefined;
  const query = new URLSearchParams({ ...target, ...(chapterNumber ? { chapterNumber } : {}) });
  try {
    signal?.throwIfAborted();
    onPhase?.("server-lookup");
    const { entry, token } = await withContentServerLookup(async deadline => {
      const token = await registerContentDevice(serverUrl, settings.deviceName, deadline);
      deadline.throwIfAborted();
      const entry = await contentServerRequest<CatalogEntry>(serverUrl, `/catalog/chapter?${query}`, token, "GET", undefined, deadline);
      deadline.throwIfAborted();
      return { entry, token };
    }, settings.lookupTimeoutSeconds ?? 3, signal);
    const identity = entry.manifest.identity;
    const sameWork = identity.novelPath === novel.path;
    const sameChapter = identity.chapterPath === chapter.path || (chapterNumber && entry.manifest.chapter?.chapterNumber != null && Number(entry.manifest.chapter.chapterNumber) === Number(chapterNumber));
    if (entry.deleted || identity.pluginId !== novel.pluginId || !sameWork || !sameChapter) {
      throw new Error("Content server download identity does not match the requested chapter.");
    }
    // A listing can be stale; the server lane takes only a copy that is complete now.
    if (options.requireComplete && !entry.complete && await canUseSourceFallback()) return false;
    signal?.throwIfAborted();
    const { downloadServerChapterFromServer } = await import("./sync");
    signal?.throwIfAborted();
    onPhase?.("server-download");
    await downloadServerChapterFromServer(entry, serverUrl, { token, target, ...(signal ? { signal } : {}) });
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof ContentServerError && error.status === 404)) throw error;
    if (!await canUseSourceFallback()) throw error;
    return false;
  }
  return true;
}
