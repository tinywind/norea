import type { ChapterRow } from "../../db/queries/chapter";
import { listNovelMigrations, readContentSyncCache, recordContentSourceDownload, writeContentSyncCache } from "../../db/queries/content-sync";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { useContentSyncStore } from "../../store/content-sync";
import { novelStorageRelativeDir } from "../chapter-storage-path";
import { LOCAL_PLUGIN_ID } from "../plugins/types";
import { normalizeContentServerUrl } from "./client";
import type { PackageManifest } from "./native";
import { listIncomingMigrationSummaries } from "./migration-feed-state";

const cacheKey = (server: string) => `norea-content-deletions:${normalizeContentServerUrl(server)}`;
const workCacheKey = (server: string) => `norea-content-work-deletions:${normalizeContentServerUrl(server)}`;

interface WorkDeletionObserver {
  excluded: Set<string>;
  liveAdded: Set<string>;
  migrationHolds: Set<string>;
}

export interface ServerWorkDeletionScope {
  /**
   * Lifts a pre-existing explicit work deletion exclusion when the server confirms an active
   * work revision newer than the recorded deletion. Active migration holds and deletions
   * recorded during the active scope are never cleared.
   */
  clearRestoredWorkExclusion(
    identity: Pick<PackageManifest["identity"], "pluginId" | "novelId">,
    restoredSequence?: number,
  ): Promise<boolean>;
}

const workDeletionObservers = new Map<string, Set<WorkDeletionObserver>>();
const workDeletionWrites = new Map<string, Promise<void>>();
const workDeletionRequests = new Map<string, Map<string, Promise<unknown>>>();

function parseWorkDeletionExclusions(saved: string | null): Map<string, number | null> {
  if (!saved) return new Map();
  const parsed = JSON.parse(saved) as unknown;
  const exclusions = new Map<string, number | null>();
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === "string" && item) exclusions.set(item, null);
    }
    return exclusions;
  }
  if (parsed && typeof parsed === "object") {
    for (const [directory, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!directory) continue;
      exclusions.set(directory, typeof value === "number" && Number.isFinite(value) ? value : null);
    }
  }
  return exclusions;
}

function serializeWorkDeletionExclusions(exclusions: ReadonlyMap<string, number | null>): string {
  return JSON.stringify(Object.fromEntries(exclusions));
}

async function readMigrationWorkHolds(server: string): Promise<Set<string>> {
  const held = new Set<string>();
  for (const job of await listNovelMigrations(normalizeContentServerUrl(server), true)) held.add(serverWorkDeletionKey(job.source));
  const incoming = await listIncomingMigrationSummaries(server, true);
  const bySource = new Map<string, typeof incoming>();
  for (const record of incoming) {
    if (record.status === "inactive") continue;
    held.add(serverWorkDeletionKey(record.source));
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
    held.add(serverWorkDeletionKey(target.identity));
    for (const successor of bySource.get(target.id) ?? []) targets.push(successor.lineage.targetWork);
  }
  return held;
}

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
  const key = workCacheKey(server);
  await workDeletionWrites.get(key);
  const saved = await readContentSyncCache(key);
  const excluded = new Set(parseWorkDeletionExclusions(saved).keys());
  for (const directory of await readMigrationWorkHolds(server)) excluded.add(directory);
  return excluded;
}

export function publishNovelMigrationSourceHold(server: string, identity: Pick<PackageManifest["identity"], "pluginId" | "novelId">): void {
  const directory = serverWorkDeletionKey(identity);
  for (const observer of workDeletionObservers.get(workCacheKey(server)) ?? []) {
    observer.excluded.add(directory);
    observer.liveAdded.add(directory);
    observer.migrationHolds.add(directory);
  }
}

export async function withServerWorkDeletionExclusions<T>(
  server: string,
  operation: (excluded: ReadonlySet<string>, scope: ServerWorkDeletionScope) => Promise<T>,
): Promise<T> {
  const key = workCacheKey(server);
  const observer: WorkDeletionObserver = {
    excluded: new Set<string>(),
    liveAdded: new Set<string>(),
    migrationHolds: new Set<string>(),
  };
  const observers = workDeletionObservers.get(key) ?? new Set<WorkDeletionObserver>();
  observers.add(observer);
  workDeletionObservers.set(key, observers);
  try {
    await workDeletionWrites.get(key);
    const saved = await readContentSyncCache(key);
    for (const directory of parseWorkDeletionExclusions(saved).keys()) observer.excluded.add(directory);
    for (const directory of await readMigrationWorkHolds(server)) {
      observer.excluded.add(directory);
      observer.migrationHolds.add(directory);
    }
    const scope: ServerWorkDeletionScope = {
      clearRestoredWorkExclusion: async (identity, restoredSequence) => {
        const directory = serverWorkDeletionKey(identity);
        if (!observer.excluded.has(directory) || observer.liveAdded.has(directory) || observer.migrationHolds.has(directory)) {
          return false;
        }
        return clearServerWorkDeletionExclusion(server, identity, { ifSequenceBelow: restoredSequence });
      },
    };
    return await operation(observer.excluded, scope);
  } finally {
    observers.delete(observer);
    if (!observers.size) workDeletionObservers.delete(key);
  }
}

export async function recordServerWorkDeletionExclusion(
  server: string,
  identity: Pick<PackageManifest["identity"], "pluginId" | "novelId">,
  deletedSequence?: number,
): Promise<void> {
  const key = workCacheKey(server);
  const directory = serverWorkDeletionKey(identity);
  const normalizedSequence = typeof deletedSequence === "number" && Number.isFinite(deletedSequence) ? deletedSequence : null;
  for (const observer of workDeletionObservers.get(key) ?? []) {
    observer.excluded.add(directory);
    observer.liveAdded.add(directory);
  }
  const pending = (workDeletionWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const saved = await readContentSyncCache(key);
    const exclusions = parseWorkDeletionExclusions(saved);
    const existing = exclusions.get(directory);
    const nextSequence = normalizedSequence !== null
      ? (existing !== undefined && existing !== null ? Math.max(existing, normalizedSequence) : normalizedSequence)
      : (existing ?? null);
    if (exclusions.has(directory) && existing === nextSequence) return;
    exclusions.set(directory, nextSequence);
    await writeContentSyncCache(key, serializeWorkDeletionExclusions(exclusions));
  }).finally(() => { if (workDeletionWrites.get(key) === pending) workDeletionWrites.delete(key); });
  workDeletionWrites.set(key, pending);
  await pending;
}

export async function clearServerWorkDeletionExclusion(
  server: string,
  identity: Pick<PackageManifest["identity"], "pluginId" | "novelId">,
  options: { ifSequenceBelow?: number } = {},
): Promise<boolean> {
  const key = workCacheKey(server);
  const directory = serverWorkDeletionKey(identity);
  const restoredSequence = typeof options.ifSequenceBelow === "number" && Number.isFinite(options.ifSequenceBelow)
    ? options.ifSequenceBelow
    : undefined;
  let cleared = false;
  const pending = (workDeletionWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const saved = await readContentSyncCache(key);
    const exclusions = parseWorkDeletionExclusions(saved);
    if (!exclusions.has(directory)) return;
    const recordedSequence = exclusions.get(directory) ?? null;
    if (restoredSequence !== undefined && recordedSequence !== null && restoredSequence <= recordedSequence) return;
    const migrationHolds = await readMigrationWorkHolds(server);
    if (migrationHolds.has(directory)) return;
    exclusions.delete(directory);
    await writeContentSyncCache(key, serializeWorkDeletionExclusions(exclusions));
    cleared = true;
    for (const observer of workDeletionObservers.get(key) ?? []) {
      if (!observer.liveAdded.has(directory) && !observer.migrationHolds.has(directory)) {
        observer.excluded.delete(directory);
      }
    }
  }).finally(() => { if (workDeletionWrites.get(key) === pending) workDeletionWrites.delete(key); });
  workDeletionWrites.set(key, pending);
  await pending;
  return cleared;
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
    if (exclusions.has(chapterKey) === deleted) return;
    if (deleted) exclusions.add(chapterKey); else exclusions.delete(chapterKey);
    await writeContentSyncCache(key, JSON.stringify([...exclusions]));
  }).finally(() => { if (chapterDeletionWrites.get(key) === pending) chapterDeletionWrites.delete(key); });
  chapterDeletionWrites.set(key, pending);
  await pending;
}

/**
 * Marks a chapter just fetched from its source as a new local copy for the configured content
 * server: lifts its deletion exclusion and journals the fetch, so sync uploads it instead of
 * treating it as a copy of the deleted server chapter.
 */
export async function recordChapterSourceDownload(
  novel: Pick<NovelDetailRecord, "pluginId" | "sourceNovelId" | "path">,
  chapter: Pick<ChapterRow, "id" | "path" | "chapterNumber">,
): Promise<void> {
  const server = useContentSyncStore.getState().serverUrl;
  if (!server || novel.sourceNovelId === null || novel.pluginId === LOCAL_PLUGIN_ID) return;
  await setServerChapterDeletionExclusion(server, {
    pluginId: novel.pluginId, novelId: novel.sourceNovelId, novelPath: novel.path, chapterPath: chapter.path,
  }, chapter.chapterNumber, false);
  await recordContentSourceDownload(chapter.id);
}
