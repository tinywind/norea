import { getChapterById } from "../../db/queries/chapter";
import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { getNovelById } from "../../db/queries/novel";
import { useContentSyncStore } from "../../store/content-sync";
import type { ChapterDownloadJob } from "../tasks/chapter-download";
import { contentServerRequest, normalizeContentServerUrl } from "./client";
import { registerContentDevice } from "./device";
import type { CatalogEntry } from "./native";

export interface ServerNovelSource {
  serverUrl: string;
  workId: string;
}

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

interface ServerChapterPage {
  items: { id: string; chapterPath: string; position: number; name: string }[];
  total: number;
  hasMore: boolean;
}

export async function listServerChapterPaths(source: ServerNovelSource, signal?: AbortSignal): Promise<Set<string>> {
  const token = await registerContentDevice(source.serverUrl, useContentSyncStore.getState().deviceName);
  const paths = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = await contentServerRequest<ServerChapterPage>(source.serverUrl,
      `/catalog/works/${encodeURIComponent(source.workId)}/chapters?offset=${offset}&limit=100`,
      token, "GET", undefined, signal);
    for (const entry of page.items) {
      paths.add(entry.chapterPath);
    }
    if (!page.hasMore) return paths;
    if (page.items.length === 0) throw new Error("Server chapter catalog did not advance.");
    offset += page.items.length;
  }
}

export async function tryDownloadServerChapter(
  job: Pick<ChapterDownloadJob, "id" | "novelId" | "pluginId" | "chapterPath">,
): Promise<boolean> {
  const chapter = await getChapterById(job.id);
  const novelId = chapter?.novelId ?? job.novelId;
  if (!novelId) return false;
  const source = await readServerNovelSource(novelId);
  if (!source) return false;
  const novel = await getNovelById(novelId);
  if (!chapter || !novel) throw new Error("Content server chapter no longer exists locally.");
  if (novel.pluginId !== job.pluginId || chapter.path !== job.chapterPath) {
    throw new Error("Content server download identity does not match the local chapter.");
  }
  const token = await registerContentDevice(source.serverUrl, useContentSyncStore.getState().deviceName);
  const query = new URLSearchParams({ pluginId: novel.pluginId, novelPath: novel.path, chapterPath: chapter.path });
  const entry = await contentServerRequest<CatalogEntry>(source.serverUrl, `/catalog/chapter?${query}`, token);
  const identity = entry.manifest.identity;
  if (identity.pluginId !== novel.pluginId || identity.novelPath !== novel.path || identity.chapterPath !== chapter.path) {
    throw new Error("Content server download identity does not match the requested chapter.");
  }
  const { downloadServerChapterFromServer } = await import("./sync");
  await downloadServerChapterFromServer(entry, source.serverUrl);
  return true;
}
