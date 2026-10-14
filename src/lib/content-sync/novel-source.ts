import { getChapterById } from "../../db/queries/chapter";
import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { getNovelById } from "../../db/queries/novel";
import { useContentSyncStore } from "../../store/content-sync";
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

const unavailableUntil = new Map<string, number>();

export async function readServerNovelSource(novelId: number): Promise<ServerNovelSource | null> {
  const saved = await readContentSyncCache(`norea-content-source:${novelId}`);
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
  await writeContentSyncCache(`norea-content-source:${novelId}`, JSON.stringify({
    serverUrl: normalizeContentServerUrl(source.serverUrl), workId: source.workId,
  }));
}

export async function listServerChapterAvailability(source: ServerNovelSource, signal?: AbortSignal): Promise<{ paths: Set<string>; numbers: Set<number> }> {
  const settings = useContentSyncStore.getState();
  return withContentServerLookup(async deadline => {
    const token = await registerContentDevice(source.serverUrl, settings.deviceName, deadline);
    const chapters = await fetchServerChapters(source, token, deadline);
    const paths = new Set(chapters.map(chapter => chapter.chapterPath));
    const counts = new Map<number, number>();
    for (const chapter of chapters) {
      if (chapter.chapterNumber == null || !/^\d+(?:\.\d+)?$/.test(chapter.chapterNumber)) continue;
      const number = Number(chapter.chapterNumber);
      counts.set(number, (counts.get(number) ?? 0) + 1);
    }
    return { paths, numbers: new Set([...counts].filter(([, count]) => count === 1).map(([number]) => number)) };
  }, settings.lookupTimeoutSeconds, signal);
}

export async function tryDownloadServerChapter(
  job: Pick<ChapterDownloadJob, "id" | "novelId" | "pluginId" | "chapterPath">,
  signal?: AbortSignal,
  onPhase?: (phase: ChapterDownloadPhase) => void,
): Promise<boolean> {
  signal?.throwIfAborted();
  const chapter = await getChapterById(job.id);
  const novelId = chapter?.novelId ?? job.novelId;
  if (!novelId) return false;
  const source = await readServerNovelSource(novelId);
  const settings = useContentSyncStore.getState();
  const serverUrl = source?.serverUrl ?? settings.serverUrl;
  if (!serverUrl) return false;
  const novel = await getNovelById(novelId);
  if (!chapter || !novel) throw new Error("Content server chapter no longer exists locally.");
  if (novel.pluginId !== job.pluginId || chapter.path !== job.chapterPath) {
    throw new Error("Content server download identity does not match the local chapter.");
  }
  const serverRequired = chapter.path.startsWith("norea-folder:") || Boolean(source && novel.isLocal);
  if (!serverRequired && (!source || pluginManager.getPlugin(novel.pluginId))
    && (unavailableUntil.get(serverUrl) ?? 0) > Date.now()) return false;
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
    signal?.throwIfAborted();
    const { downloadServerChapterFromServer } = await import("./sync");
    signal?.throwIfAborted();
    onPhase?.("server-download");
    await downloadServerChapterFromServer(entry, serverUrl, { token, target, ...(signal ? { signal } : {}) });
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof ContentServerError && error.status === 404)) unavailableUntil.set(serverUrl, Date.now() + 30_000);
    if (serverRequired) throw error;
    if (source && !pluginManager.getPlugin(novel.pluginId)) {
      await pluginManager.loadInstalledFromDb();
      signal?.throwIfAborted();
      if (!pluginManager.getPlugin(novel.pluginId)) throw error;
    }
    return false;
  }
  unavailableUntil.delete(serverUrl);
  return true;
}
