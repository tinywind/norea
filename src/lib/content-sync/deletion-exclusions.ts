import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { novelStorageRelativeDir } from "../chapter-storage-path";
import { normalizeContentServerUrl } from "./client";
import type { PackageManifest } from "./native";

const cacheKey = (server: string) => `norea-content-deletions:${normalizeContentServerUrl(server)}`;
const workCacheKey = (server: string) => `norea-content-work-deletions:${normalizeContentServerUrl(server)}`;

export function serverWorkDeletionKey(identity: Pick<PackageManifest["identity"], "pluginId" | "novelId">): string {
  return novelStorageRelativeDir({ pluginId: identity.pluginId, sourceNovelId: identity.novelId });
}

export async function readServerWorkDeletionExclusions(server: string): Promise<Set<string>> {
  const saved = await readContentSyncCache(workCacheKey(server));
  return new Set(saved ? JSON.parse(saved) as string[] : []);
}

export async function recordServerWorkDeletionExclusion(server: string, identity: Pick<PackageManifest["identity"], "pluginId" | "novelId">): Promise<void> {
  const exclusions = await readServerWorkDeletionExclusions(server);
  const key = serverWorkDeletionKey(identity);
  if (exclusions.has(key)) return;
  exclusions.add(key);
  await writeContentSyncCache(workCacheKey(server), JSON.stringify([...exclusions]));
}

export function serverChapterDeletionKey(identity: Pick<PackageManifest["identity"], "pluginId" | "novelId" | "chapterPath">, chapterNumber?: string | null): string {
  const chapter = chapterNumber != null && /^\d+(?:\.\d+)?$/.test(chapterNumber) ? ["number", Number(chapterNumber)] : ["path", identity.chapterPath];
  return JSON.stringify([identity.pluginId, identity.novelId, chapter]);
}

export async function readServerChapterDeletionExclusions(server: string): Promise<Set<string>> {
  const saved = await readContentSyncCache(cacheKey(server));
  return new Set(saved ? JSON.parse(saved) as string[] : []);
}

export async function setServerChapterDeletionExclusion(server: string, identity: PackageManifest["identity"], chapterNumber: string | null | undefined, deleted: boolean): Promise<void> {
  const exclusions = await readServerChapterDeletionExclusions(server);
  const key = serverChapterDeletionKey(identity, chapterNumber);
  if (deleted) exclusions.add(key); else exclusions.delete(key);
  await writeContentSyncCache(cacheKey(server), JSON.stringify([...exclusions]));
}
