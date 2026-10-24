import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { findNovelBySource } from "../../db/queries/novel";
import { useContentSyncStore } from "../../store/content-sync";
import { bytesToBase64 } from "../base64";
import { installStoredNovelMetadata, parseNovelMetadata, type NovelMetadataV1 } from "../work-metadata";
import { ContentServerError, contentServerRequest, normalizeContentServerUrl, withContentServerLookup } from "./client";
import { registerContentDevice } from "./device";
import { serverWorkDeletionKey, withServerWorkDeletionExclusions, waitForServerWorkDeletion } from "./deletion-exclusions";
import { rememberServerNovelSource, type ServerNovelSource } from "./novel-source";
import { contentWorkId, recordInstalledWorkMetadata, runWorkMetadataSyncOperation, type WorkCatalogEntry } from "./works";
import { fetchServerChapters } from "./chapters";
import { cacheServerChapters } from "../../db/queries/content-sync";

export interface ServerWorkSummary {
  id: string;
  sequence: number;
  identity: NovelMetadataV1["identity"];
  novel: NovelMetadataV1["novel"];
  hasCover: boolean;
  chapterCount: number;
}
export interface ServerWorkPage { items: ServerWorkSummary[]; total: number; hasMore: boolean }
export interface ServerSourceSummary { id: string; workCount: number }

export function listServerWorks(server: string, token: string, query: string, source: string, offset: number, signal?: AbortSignal): Promise<ServerWorkPage> {
  const params = new URLSearchParams({ q: query, offset: String(offset), limit: "40" });
  if (source) params.set("source", source);
  return contentServerRequest(server, `/catalog/works?${params}`, token, "GET", undefined, signal);
}

export async function readServerCover(server: string, token: string, id: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
  return withContentServerLookup(async deadline => {
    const response = await nativeFetch(`${normalizeContentServerUrl(server)}/api/v1/works/${encodeURIComponent(id)}/cover`, {
      headers: { Authorization: `Bearer ${token}` }, maxRedirections: 0, connectTimeout: 10_000,
      signal: deadline,
    });
    if (!response.ok) throw new ContentServerError(response.status);
    if (Number(response.headers.get("content-length")) > 10 * 1024 * 1024) throw new Error("Server cover exceeds the size limit.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Server cover is empty or exceeds the size limit.");
    const contentType = response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    if (!contentType.startsWith("image/") && contentType !== "application/octet-stream") throw new Error("Server cover is not an image.");
    return { bytes, contentType };
  }, 30, signal);
}

export async function serverCoverSource(server: string, token: string, id: string, signal?: AbortSignal): Promise<string> {
  const cover = await readServerCover(server, token, id, signal);
  return `data:${cover.contentType === "application/octet-stream" ? "image/jpeg" : cover.contentType};base64,${bytesToBase64(cover.bytes)}`;
}

export async function openServerNovel(server: string, work: ServerWorkSummary): Promise<number> {
  const source = { serverUrl: normalizeContentServerUrl(server), workId: work.id };
  if (await contentWorkId(work.identity) !== work.id) throw new Error("Server work identity does not match its metadata.");
  const existing = await findNovelBySource(work.identity.pluginId, work.identity.novelPath);
  if (!existing) return refreshServerNovel(source, true);
  await rememberServerNovelSource(existing.id, source);
  return existing.id;
}

export async function refreshServerNovel(source: ServerNovelSource, requireNewWork = false): Promise<number> {
  const server = normalizeContentServerUrl(source.serverUrl);
  return runWorkMetadataSyncOperation(server, () => withServerWorkDeletionExclusions(server, async excluded => {
    const token = await registerContentDevice(server, useContentSyncStore.getState().deviceName);
    const entry = await contentServerRequest<WorkCatalogEntry>(server, `/works/${encodeURIComponent(source.workId)}`, token);
    const metadata = parseNovelMetadata(entry.metadata);
    if (entry.id !== source.workId || await contentWorkId(metadata.identity) !== source.workId) throw new Error("Server work identity does not match its metadata.");
    const cover = entry.hasCover ? await readServerCover(server, token, source.workId) : null;
    const chapters = await fetchServerChapters({ serverUrl: server, workId: source.workId }, token);
    await waitForServerWorkDeletion(server, source.workId);
    const isDeleted = () => excluded.has(serverWorkDeletionKey(metadata.identity));
    if (isDeleted()) throw new ContentServerError(410);
    const installed = await installStoredNovelMetadata(metadata, cover?.bytes, async current => {
      if (isDeleted() || (requireNewWork && current)) return false;
    });
    if (isDeleted()) throw new ContentServerError(410);
    if (installed === null) throw new Error("This work was installed while opening it. Open it again to use its local metadata.");
    await recordInstalledWorkMetadata(server, installed, entry.hasCover);
    const novel = await findNovelBySource(metadata.identity.pluginId, metadata.identity.novelPath);
    if (!novel) throw new Error("Installed server work is missing from the local index.");
    await cacheServerChapters(novel.id, chapters);
    await rememberServerNovelSource(novel.id, { serverUrl: server, workId: source.workId });
    window.dispatchEvent(new Event("norea-content-state-changed"));
    return novel.id;
  }));
}
