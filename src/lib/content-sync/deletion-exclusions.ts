import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { novelStorageRelativeDir } from "../chapter-storage-path";
import { normalizeContentServerUrl } from "./client";
import type { PackageManifest } from "./native";

const cacheKey = (server: string) => `norea-content-deletions:${normalizeContentServerUrl(server)}`;
const workCacheKey = (server: string) => `norea-content-work-deletions:${normalizeContentServerUrl(server)}`;
const workDeletionObservers = new Map<string, Set<Set<string>>>();
const workDeletionWrites = new Map<string, Promise<void>>();
const workDeletionRequests = new Map<string, Map<string, Promise<unknown>>>();

export function runServerWorkDeletion<T>(server: string, workId: string, operation: () => Promise<T>): Promise<T> {
  const key = workCacheKey(server);
  const requests = workDeletionRequests.get(key) ?? new Map<string, Promise<unknown>>();
  workDeletionRequests.set(key, requests);
  const pending = (requests.get(workId) ?? Promise.resolve()).catch(() => undefined).then(operation).finally(() => {
    if (requests.get(workId) === pending) requests.delete(workId);
    if (!requests.size) workDeletionRequests.delete(key);
  });
  requests.set(workId, pending);
  return pending;
}

export async function waitForServerWorkDeletion(server: string, workId: string): Promise<void> {
  await workDeletionRequests.get(workCacheKey(server))?.get(workId)?.catch(() => undefined);
}

export function serverWorkDeletionKey(identity: Pick<PackageManifest["identity"], "pluginId" | "novelId">): string {
  return novelStorageRelativeDir({ pluginId: identity.pluginId, sourceNovelId: identity.novelId });
}

export async function readServerWorkDeletionExclusions(server: string): Promise<Set<string>> {
  const saved = await readContentSyncCache(workCacheKey(server));
  return new Set(saved ? JSON.parse(saved) as string[] : []);
}

export async function withServerWorkDeletionExclusions<T>(server: string, operation: (excluded: ReadonlySet<string>) => Promise<T>): Promise<T> {
  const key = workCacheKey(server);
  const excluded = new Set<string>();
  const observers = workDeletionObservers.get(key) ?? new Set<Set<string>>();
  observers.add(excluded);
  workDeletionObservers.set(key, observers);
  try {
    await workDeletionWrites.get(key);
    for (const directory of await readServerWorkDeletionExclusions(server)) excluded.add(directory);
    return await operation(excluded);
  } finally {
    observers.delete(excluded);
    if (!observers.size) workDeletionObservers.delete(key);
  }
}

export async function recordServerWorkDeletionExclusion(server: string, identity: Pick<PackageManifest["identity"], "pluginId" | "novelId">): Promise<void> {
  const key = workCacheKey(server);
  const directory = serverWorkDeletionKey(identity);
  for (const observer of workDeletionObservers.get(key) ?? []) observer.add(directory);
  const pending = (workDeletionWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const exclusions = await readServerWorkDeletionExclusions(server);
    if (exclusions.has(directory)) return;
    exclusions.add(directory);
    await writeContentSyncCache(key, JSON.stringify([...exclusions]));
  }).finally(() => { if (workDeletionWrites.get(key) === pending) workDeletionWrites.delete(key); });
  workDeletionWrites.set(key, pending);
  await pending;
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
