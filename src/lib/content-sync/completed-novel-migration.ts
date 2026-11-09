import { listNovelMigrations, readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { ContentServerError, contentServerRequest, normalizeContentServerUrl } from "./client";
import { runServerWorkDeletion } from "./deletion-exclusions";
import { listIncomingMigrations } from "./migration-feed-state";
import { buildFinalizeNovelMigrationRequest, PendingNovelMigrationError } from "./novel-migration";
import type { FinalizeWorkMigrationRequest, MigrationWorkIdentity, PendingNovelMigration, WorkMigrationSnapshot } from "./novel-migration-types";
import { contentWorkId, recordDeletedWorkMetadata, type WorkCatalogEntry } from "./works";

export interface CompletedNovelMigrationRequest {
  legacyOperationId: string;
  legacyRequest: FinalizeWorkMigrationRequest;
  current: FinalizeWorkMigrationRequest;
}
interface ReconciliationCache {
  version: 1;
  completed: boolean;
  request?: CompletedNovelMigrationRequest;
}
const sameIdentity = (a: MigrationWorkIdentity, b: MigrationWorkIdentity) =>
  a.pluginId === b.pluginId && a.novelId === b.novelId && a.novelPath === b.novelPath;
const cacheKey = (server: string, operationId: string) => "norea-completed-migration:" + JSON.stringify([server, operationId]);

function snapshotMatches(snapshot: WorkMigrationSnapshot, identity: MigrationWorkIdentity, id: string): boolean {
  return snapshot?.work?.id === id && !!snapshot.work.revision && sameIdentity(snapshot.work.identity, identity) &&
    Array.isArray(snapshot.chapters) && new Set(snapshot.chapters.map(chapter => chapter.chapterPath)).size === snapshot.chapters.length;
}

/** Reuse explicit path mappings while taking storage numbers from the current catalog.
 * A source number and a user's displayed chapter order are never interchangeable. */
export function buildCompletedNovelMigrationRequest(
  job: PendingNovelMigration, source: WorkMigrationSnapshot, target: WorkMigrationSnapshot, operationId: string,
): CompletedNovelMigrationRequest {
  if (job.status !== "completed" || !job.request || job.request.operationId !== job.operationId ||
      !sameIdentity(source.work.identity, job.source) || !sameIdentity(target.work.identity, job.target) ||
      job.request.target.id !== target.work.id) {
    throw new Error("The completed migration does not match the current source and target.");
  }
  const sourceByPath = new Map(source.chapters.map(chapter => [chapter.chapterPath, chapter]));
  const targetByPath = new Map(target.chapters.map(chapter => [chapter.chapterPath, chapter]));
  const chapters = job.chapters.map(chapter => {
    const currentSource = sourceByPath.get(chapter.sourceChapterPath);
    const currentTarget = chapter.targetChapterPath ? targetByPath.get(chapter.targetChapterPath) : undefined;
    if (chapter.targetChapterPath && !currentTarget) {
      // Only the composition itself can prove a metadata-only composed entry.
      const entry = target.work.metadata?.chapterComposition?.entries.find(value =>
        value.path === chapter.targetChapterPath && value.user.included);
      if (!entry) throw new Error("A completed migration target chapter is no longer present in the current catalog.");
      return { ...chapter, sourceChapterNumber: currentSource ? currentSource.chapterNumber : chapter.sourceChapterNumber,
        targetChapterNumber: entry.storageChapterNumber };
    }
    return { ...chapter, sourceChapterNumber: currentSource ? currentSource.chapterNumber : chapter.sourceChapterNumber,
      targetChapterNumber: currentTarget ? currentTarget.chapterNumber : chapter.targetChapterNumber };
  });
  const current = buildFinalizeNovelMigrationRequest({ ...job, operationId, chapters }, source, target);
  return { legacyOperationId: job.operationId, legacyRequest: job.request, current };
}

/** Report already approved work moves before another device can reimport a retired source.
 * The exact legacy request proves the old decision; the new request verifies current files. */
export async function reconcileCompletedNovelMigrations(
  serverUrl: string, token: string, assertCurrent: () => void = () => undefined,
  signal?: AbortSignal,
): Promise<number> {
  const server = normalizeContentServerUrl(serverUrl);
  const check = () => { signal?.throwIfAborted(); assertCurrent(); };
  check();
  const inactive = new Set((await listIncomingMigrations(server, true)).filter(receipt => !receipt.lineage.active).flatMap(receipt => [receipt.operationId, ...(receipt.lineage.legacyOperationId ? [receipt.lineage.legacyOperationId] : [])]));
  const jobs = (await listNovelMigrations(server, true)).filter(job => job.status === "completed" && job.request && !inactive.has(job.operationId));
  check();
  const pending: { job: PendingNovelMigration; saved: ReconciliationCache | null }[] = [];
  for (const job of jobs) {
    const raw = await readContentSyncCache(cacheKey(server, job.operationId));
    const saved = raw ? JSON.parse(raw) as ReconciliationCache : null;
    if (saved && (saved.version !== 1 || typeof saved.completed !== "boolean" ||
      saved.request && saved.request.legacyOperationId !== job.operationId)) {
      throw new Error("The retained work migration reconciliation is invalid.");
    }
    if (!saved?.completed) pending.push({ job, saved });
  }
  if (!pending.length) return 0;
  const capabilities = await contentServerRequest<{ workMigrationReconcileVersion?: number }>(
    server, "/capabilities", token, "GET", undefined, signal);
  check();
  if (capabilities.workMigrationReconcileVersion !== 1) return 0;
  let completed = 0;
  for (const { job, saved } of pending) {
    check();
    const sourceId = await contentWorkId(job.source);
    let request = saved?.request;
    if (!request) {
      let source: WorkMigrationSnapshot;
      try {
        source = await contentServerRequest<WorkMigrationSnapshot>(server, "/works/" + sourceId + "/migration-snapshot", token, "GET", undefined, signal);
      } catch (error) {
        check();
        if (error instanceof ContentServerError && (error.status === 404 || error.status === 410)) {
          await writeContentSyncCache(cacheKey(server, job.operationId), JSON.stringify({ version: 1, completed: true }));
          continue;
        }
        throw error;
      }
      const targetId = await contentWorkId(job.target);
      const target = await contentServerRequest<WorkMigrationSnapshot>(server, "/works/" + targetId + "/migration-snapshot", token, "GET", undefined, signal);
      check();
      if (!snapshotMatches(source, job.source, sourceId) || !snapshotMatches(target, job.target, targetId)) {
        throw new PendingNovelMigrationError(1, "The current migration metadata does not match its saved identities.", false);
      }
      try { request = buildCompletedNovelMigrationRequest(job, source, target, crypto.randomUUID()); }
      catch (error) {
        throw new PendingNovelMigrationError(1, error instanceof Error ? error.message : String(error), false);
      }
      await writeContentSyncCache(cacheKey(server, job.operationId), JSON.stringify({ version: 1, completed: false, request }));
    }
    check();
    const exact = request;
    await runServerWorkDeletion(server, sourceId, async () => {
      let result: { operationId: string; deletedWork: WorkCatalogEntry };
      try {
        result = await contentServerRequest(server, "/works/" + sourceId + "/migration-reconcile", token, "POST", exact, signal, 300);
      } catch (error) {
        check();
        if (error instanceof ContentServerError && error.status === 409)
          throw new PendingNovelMigrationError(1, "The migrated work changed; its source files were retained.", false);
        throw error;
      }
      check();
      if (result.operationId !== exact.current.operationId || result.deletedWork?.id !== sourceId ||
          !result.deletedWork.deleted || !sameIdentity(result.deletedWork.metadata.identity, job.source)) {
        throw new Error("The server did not confirm the completed work migration.");
      }
      await recordDeletedWorkMetadata(server, result.deletedWork);
      await writeContentSyncCache(cacheKey(server, job.operationId), JSON.stringify({ version: 1, completed: true, request: exact }));
      completed++;
    });
  }
  return completed;
}
