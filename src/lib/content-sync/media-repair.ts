import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { getChapterById } from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import { useContentSyncStore } from "../../store/content-sync";
import { isAbortError } from "../abort";
import type { ChapterMediaManifestFile } from "../chapter-media/types";
import { pluginManager } from "../plugins/manager";
import type { ChapterMediaRepairJob } from "../tasks/chapter-download";
import { ContentServerError, contentServerRequest, normalizeContentServerUrl, withContentServerLookup } from "./client";
import { forgetContentDeviceRegistration, registerContentDevice } from "./device";
import type { CatalogEntry } from "./native";
import { readServerNovelSource } from "./novel-source";

interface ServerChapterMediaSource {
  serverUrl: string;
  token: string;
  entry: CatalogEntry;
}

export function createServerChapterMediaFetcher(
  job: Pick<ChapterMediaRepairJob, "id" | "pluginId">,
  signal?: AbortSignal,
): (file: ChapterMediaManifestFile) => Promise<Response | null> {
  let lookup: Promise<ServerChapterMediaSource | null> | undefined;
  const resolveChapter = async (): Promise<ServerChapterMediaSource | null> => {
    signal?.throwIfAborted();
    const chapter = await getChapterById(job.id);
    if (!chapter) throw new Error("Content server repair chapter no longer exists locally.");
    const source = await readServerNovelSource(chapter.novelId);
    const settings = useContentSyncStore.getState();
    const serverUrl = source?.serverUrl ?? settings.serverUrl;
    if (!serverUrl) return null;
    const novel = await getNovelById(chapter.novelId);
    if (!novel || novel.pluginId !== job.pluginId) throw new Error("Content server repair identity does not match the local work.");
    const number = chapter.chapterNumber ?? (chapter.position > 0 ? String(chapter.position) : undefined);
    const chapterNumber = number && /^\d+(?:\.\d+)?$/.test(number) ? number : undefined;
    const query = new URLSearchParams({ pluginId: novel.pluginId, novelPath: novel.path, chapterPath: chapter.path,
      includeUnavailable: "true", ...(chapterNumber ? { chapterNumber } : {}) });
    return withContentServerLookup(async deadline => {
      const token = await registerContentDevice(serverUrl, settings.deviceName, deadline);
      deadline.throwIfAborted();
      const entry = await contentServerRequest<CatalogEntry>(serverUrl, `/catalog/chapter?${query}`, token, "GET", undefined, deadline);
      deadline.throwIfAborted();
      const identity = entry.manifest.identity;
      const sameChapter = identity.chapterPath === chapter.path || (chapterNumber && entry.manifest.chapter.chapterNumber != null
        && Number(entry.manifest.chapter.chapterNumber) === Number(chapterNumber));
      if (entry.deleted || identity.pluginId !== novel.pluginId || identity.novelId !== novel.sourceNovelId
        || identity.novelPath !== novel.path || !sameChapter) {
        throw new Error("Content server media identity does not match the requested chapter.");
      }
      return { serverUrl, token, entry };
    }, settings.lookupTimeoutSeconds ?? 3, signal);
  };

  return async file => {
    signal?.throwIfAborted();
    try {
      const source = await (lookup ??= resolveChapter());
      signal?.throwIfAborted();
      if (!source) return null;
      return await withContentServerLookup(async deadline => {
        const query = new URLSearchParams({ revision: source.entry.revision, fileName: file.fileName, sourceUrl: file.sourceUrl });
        const response = await nativeFetch(`${normalizeContentServerUrl(source.serverUrl)}/api/v1/chapters/${encodeURIComponent(source.entry.id)}/media?${query}`, {
          headers: { Authorization: `Bearer ${source.token}` }, connectTimeout: 10_000,
          maxRedirections: 0, signal: deadline,
        });
        deadline.throwIfAborted();
        if (!response.ok) {
          if (response.status === 401) forgetContentDeviceRegistration(source.serverUrl, source.token);
          throw new ContentServerError(response.status);
        }
        const expectedBytes = Number(response.headers.get("Content-Length"));
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > 256 * 1024 ** 2) {
          throw new Error("Content server media response size is invalid.");
        }
        const body = await response.arrayBuffer();
        deadline.throwIfAborted();
        if (body.byteLength !== expectedBytes) throw new Error("Content server media response size does not match its body.");
        return new Response(body, { status: response.status, headers: response.headers });
      }, 30, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (isAbortError(error)) throw error;
      if (/^https?:\/\//i.test(file.sourceUrl) && pluginManager.getPlugin(job.pluginId)) return null;
      throw error;
    }
  };
}
