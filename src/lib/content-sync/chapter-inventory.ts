import type { ChapterCleanupCandidate } from "../../db/queries/chapter-cleanup";
import { useContentSyncStore } from "../../store/content-sync";
import { isChapterPayloadInventory, type ChapterPayloadInventory } from "../chapter-content/inventory";
import { contentServerRequest, normalizeContentServerUrl, withContentServerLookup } from "./client";
import { registerContentDevice } from "./device";
import type { CatalogEntry, PackageManifest } from "./native";

export interface ServerChapterInventory {
  serverUrl: string;
  id: string;
  revision: string;
  identity: PackageManifest["identity"];
  inventory: ChapterPayloadInventory;
}

export function cleanupServerUrl(candidate: ChapterCleanupCandidate, fallback: string): string {
  if (!candidate.serverSource) return fallback ? normalizeContentServerUrl(fallback) : "";
  const source: unknown = JSON.parse(candidate.serverSource);
  if (!source || typeof source !== "object" || !("serverUrl" in source) || typeof source.serverUrl !== "string"
    || !("workId" in source) || typeof source.workId !== "string" || !source.workId) {
    throw new Error("Stored content server association is invalid.");
  }
  return normalizeContentServerUrl(source.serverUrl);
}

export async function fetchCleanupServerInventory(candidate: ChapterCleanupCandidate, serverUrl: string, signal?: AbortSignal, presenceOnly = false): Promise<ServerChapterInventory> {
  const settings = useContentSyncStore.getState();
  return withContentServerLookup(async deadline => {
    const token = await registerContentDevice(serverUrl, settings.deviceName, deadline);
    const { novel, chapter } = candidate.identity;
    const number = chapter.chapterNumber ?? String(chapter.position ?? "");
    const chapterNumber = /^\d+(?:\.\d+)?$/.test(number) ? number : undefined;
    const query = new URLSearchParams({ pluginId: novel.pluginId, novelPath: candidate.novelPath, chapterPath: candidate.chapterPath, ...(presenceOnly ? { includeUnavailable: "true" } : {}), ...(chapterNumber ? { chapterNumber } : {}) });
    const entry = await contentServerRequest<CatalogEntry>(serverUrl, `/catalog/chapter?${query}`, token, "GET", undefined, deadline);
    const identity = entry?.manifest?.identity;
    const sameChapter = identity?.chapterPath === candidate.chapterPath
      || (chapterNumber !== undefined && entry?.manifest?.chapter?.chapterNumber != null
        && Number(entry.manifest.chapter.chapterNumber) === Number(chapterNumber));
    if (entry.deleted || !entry.id || !entry.revision || identity?.pluginId !== novel.pluginId
      || identity.novelPath !== candidate.novelPath || identity.novelId !== novel.sourceNovelId || !sameChapter) {
      throw new Error("Content server chapter identity does not match the device chapter.");
    }
    const response = await contentServerRequest<Omit<ServerChapterInventory, "serverUrl" | "id">>(serverUrl,
      `/chapters/${encodeURIComponent(entry.id)}/storage-inventory?revision=${encodeURIComponent(entry.revision)}${presenceOnly ? "&presenceOnly=true" : ""}`, token, "GET", undefined, deadline);
    if (response?.revision !== entry.revision || response.identity?.pluginId !== identity.pluginId
      || response.identity.novelId !== identity.novelId || response.identity.novelPath !== identity.novelPath
      || response.identity.chapterPath !== identity.chapterPath || !isChapterPayloadInventory(response.inventory)) {
      throw new Error("Content server returned invalid or changed chapter inventory.");
    }
    deadline.throwIfAborted();
    return { serverUrl, id: entry.id, identity: response.identity, revision: response.revision, inventory: response.inventory };
  }, settings.lookupTimeoutSeconds, signal);
}
