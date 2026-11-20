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
  /** True when the server package manifest lists neither `manifest.json` nor `media.zip`. */
  noMediaDeclared?: boolean;
}

export interface ServerCompleteChapter {
  serverUrl: string;
  id: string;
  revision: string;
}

export type ServerCompleteChapterResult =
  | { ok: true; chapter: ServerCompleteChapter }
  | { ok: false; reason: "server-missing" | "not-complete" };

const FOLDER_CHAPTER_PATH = /^norea-folder:(\d+(?:\.\d+)?)$/;

function numericChapterValue(value: string | null | undefined): string | undefined {
  return value != null && /^\d+(?:\.\d+)?$/.test(value) ? value : undefined;
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

export async function verifyServerCompleteChapter(
  candidate: ChapterCleanupCandidate,
  serverUrl: string,
  signal?: AbortSignal,
): Promise<ServerCompleteChapterResult> {
  const settings = useContentSyncStore.getState();
  return withContentServerLookup(async (deadline) => {
    const token = await registerContentDevice(serverUrl, settings.deviceName, deadline);
    const { novel, chapter } = candidate.identity;
    const localFolderNumber = FOLDER_CHAPTER_PATH.exec(candidate.chapterPath)?.[1];
    const localChapterNumber = numericChapterValue(chapter.chapterNumber ?? localFolderNumber);
    const query = new URLSearchParams({
      pluginId: novel.pluginId,
      novelPath: candidate.novelPath,
      chapterPath: candidate.chapterPath,
      ...(localChapterNumber ? { chapterNumber: localChapterNumber } : {}),
    });
    const entry = await contentServerRequest<CatalogEntry>(
      serverUrl,
      `/catalog/chapter?${query}`,
      token,
      "GET",
      undefined,
      deadline,
    );
    deadline.throwIfAborted();
    if (entry?.deleted) {
      return { ok: false, reason: "server-missing" };
    }
    const identity = entry?.manifest?.identity;
    const remoteFolderNumber = identity?.chapterPath
      ? FOLDER_CHAPTER_PATH.exec(identity.chapterPath)?.[1]
      : undefined;
    const remoteChapterNumber = numericChapterValue(
      entry?.manifest?.chapter?.chapterNumber ?? remoteFolderNumber,
    );
    const isFolderAlias = Boolean(localFolderNumber || remoteFolderNumber);
    const sameChapter =
      identity?.chapterPath === candidate.chapterPath ||
      (isFolderAlias &&
        localChapterNumber !== undefined &&
        remoteChapterNumber !== undefined &&
        Number(localChapterNumber) === Number(remoteChapterNumber));
    if (
      !entry?.id ||
      !entry.revision ||
      identity?.pluginId !== novel.pluginId ||
      identity.novelPath !== candidate.novelPath ||
      identity.novelId !== novel.sourceNovelId ||
      !sameChapter
    ) {
      throw new Error("Content server chapter identity does not match the device chapter.");
    }
    if (entry.complete !== true) {
      return { ok: false, reason: "not-complete" };
    }
    const bodyPath = entry.manifest.bodyPath;
    const bodyFile = Array.isArray(entry.manifest.files)
      ? entry.manifest.files.find((file) => file.path === bodyPath)
      : undefined;
    if (!bodyPath || !bodyFile || typeof bodyFile.size !== "number" || bodyFile.size <= 0) {
      return { ok: false, reason: "not-complete" };
    }
    return {
      ok: true,
      chapter: { serverUrl, id: entry.id, revision: entry.revision },
    };
  }, settings.lookupTimeoutSeconds, signal);
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
    const noMediaDeclared =
      Array.isArray(entry.manifest?.files) &&
      !entry.manifest.files.some((file) => file.path === "manifest.json" || file.path === "media.zip");
    const response = await contentServerRequest<Omit<ServerChapterInventory, "serverUrl" | "id">>(serverUrl,
      `/chapters/${encodeURIComponent(entry.id)}/storage-inventory?revision=${encodeURIComponent(entry.revision)}${presenceOnly ? "&presenceOnly=true" : ""}`, token, "GET", undefined, deadline);
    if (response?.revision !== entry.revision || response.identity?.pluginId !== identity.pluginId
      || response.identity.novelId !== identity.novelId || response.identity.novelPath !== identity.novelPath
      || response.identity.chapterPath !== identity.chapterPath || !isChapterPayloadInventory(response.inventory)) {
      throw new Error("Content server returned invalid or changed chapter inventory.");
    }
    deadline.throwIfAborted();
    return {
      serverUrl,
      id: entry.id,
      identity: response.identity,
      revision: response.revision,
      inventory: response.inventory,
      noMediaDeclared,
    };
  }, settings.lookupTimeoutSeconds, signal);
}
