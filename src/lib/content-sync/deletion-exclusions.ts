import { listNovelMigrations, readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { novelStorageRelativeDir } from "../chapter-storage-path";
import { normalizeContentServerUrl } from "./client";
import type { PackageManifest } from "./native";
import { listIncomingMigrations } from "./migration-feed-state";

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
  const excluded = new Set(saved ? JSON.parse(saved) as string[] : []);
  for (const job of await listNovelMigrations(normalizeContentServerUrl(server), true)) excluded.add(serverWorkDeletionKey(job.source));
  const incoming = await listIncomingMigrations(server, true);
  const bySource = new Map<string, typeof incoming>();
  for (const record of incoming) {
    if (record.status === "inactive") continue;
    excluded.add(serverWorkDeletionKey(record.source));
    const successors = bySource.get(record.lineage.sourceWork.id) ?? [];
    successors.push(record);
    bySource.set(record.lineage.sourceWork.id, successors);
  }
  // Pending recipients must not upload their old target metadata or payloads before replay succeeds.
  // Follow every reachable target even when a conflicting or incomplete chain needs review.
  const targets = incoming.filter(record => record.status !== "completed" && record.status !== "inactive").map(record => record.lineage.targetWork);
  const visited = new Set<string>();
  while (targets.length) {
    const target = targets.pop()!;
    if (visited.has(target.id)) continue;
    visited.add(target.id);
    excluded.add(serverWorkDeletionKey(target.identity));
    for (const successor of bySource.get(target.id) ?? []) targets.push(successor.lineage.targetWork);
  }
  return excluded;
}

export function publishNovelMigrationSourceHold(server: string, identity: Pick<PackageManifest["identity"], "pluginId" | "novelId">): void {
  const directory = serverWorkDeletionKey(identity);
  for (const observer of workDeletionObservers.get(workCacheKey(server)) ?? []) observer.add(directory);
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
    const saved = await readContentSyncCache(key);
    const exclusions = new Set(saved ? JSON.parse(saved) as string[] : []);
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

const chapterDeletionWrites = new Map<string, Promise<void>>();

export async function readServerChapterDeletionExclusions(server: string): Promise<Set<string>> {
  const key = cacheKey(server);
  await chapterDeletionWrites.get(key);
  const saved = await readContentSyncCache(key);
  return new Set(saved ? JSON.parse(saved) as string[] : []);
}

export async function setServerChapterDeletionExclusion(server: string, identity: PackageManifest["identity"], chapterNumber: string | null | undefined, deleted: boolean): Promise<void> {
  const key = cacheKey(server);
  const chapterKey = serverChapterDeletionKey(identity, chapterNumber);
  const pending = (chapterDeletionWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const saved = await readContentSyncCache(key);
    const exclusions = new Set(saved ? JSON.parse(saved) as string[] : []);
    if (deleted) exclusions.add(chapterKey); else exclusions.delete(chapterKey);
    await writeContentSyncCache(key, JSON.stringify([...exclusions]));
  }).finally(() => { if (chapterDeletionWrites.get(key) === pending) chapterDeletionWrites.delete(key); });
  chapterDeletionWrites.set(key, pending);
  await pending;
}
