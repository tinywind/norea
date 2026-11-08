import { getDb } from "../../db/client";
import { writeContentSyncCache } from "../../db/queries/content-sync";
import {
  SERVER_CHAPTER_RENUMBER_PREFIX,
  canonicalChapterNumber,
  assertSourceChapterNumberChangesSupported,
  type ServerChapterRenumberJob,
} from "../source-chapter-renumber";
import { ContentServerError, contentServerRequest } from "./client";
import type { WorkMigrationSnapshot } from "./novel-migration-types";
import { contentWorkId, type WorkCatalogEntry } from "./works";
import { readServerWorkDeletionExclusions, serverWorkDeletionKey } from "./deletion-exclusions";

function parseJob(payload: string): ServerChapterRenumberJob {
  const job = JSON.parse(payload) as ServerChapterRenumberJob;
  if (job.version !== 1 || typeof job.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.operationId) ||
      typeof job.serverUrl !== "string" || !job.identity ||
      [job.identity.pluginId, job.identity.novelId, job.identity.novelPath].some(value => typeof value !== "string" || !value) ||
      !Array.isArray(job.mappings) || !job.mappings.length || !["pending", "completed"].includes(job.status)) {
    throw new Error("Stored server chapter number reconciliation is invalid. Synchronization was held.");
  }
  const oldNumbers = new Set<string>();
  const newNumbers = new Set<string>();
  const paths = new Set<string>();
  for (const mapping of job.mappings) {
    if (!mapping || typeof mapping.chapterPath !== "string" || !mapping.chapterPath ||
        canonicalChapterNumber(mapping.from) !== mapping.from || canonicalChapterNumber(mapping.to) !== mapping.to ||
        mapping.from === mapping.to || oldNumbers.has(mapping.from) || newNumbers.has(mapping.to) || paths.has(mapping.chapterPath)) {
      throw new Error("Stored server chapter number mapping is invalid. Synchronization was held.");
    }
    oldNumbers.add(mapping.from); newNumbers.add(mapping.to); paths.add(mapping.chapterPath);
  }
  assertSourceChapterNumberChangesSupported(job.mappings.map(mapping => ({
    chapterNumber: mapping.from, nextChapterNumber: mapping.to, nextPath: mapping.chapterPath,
  })));
  if ([...oldNumbers].some(number => newNumbers.has(number))) throw new Error("Stored server chapter number mapping overlaps.");
  if (job.request && (job.request.operationId !== job.operationId || !job.request.expectedWorkRevision ||
      JSON.stringify(job.request.mappings) !== JSON.stringify(job.mappings))) {
    throw new Error("Stored server chapter number request does not match its mapping.");
  }
  return job;
}

export async function listPendingChapterNumberReconciliations(server: string): Promise<ServerChapterRenumberJob[]> {
  const db = await getDb();
  const rows = await db.select<{ payload: string }[]>(
    "SELECT payload FROM content_sync_cache WHERE cache_key LIKE $1 AND json_extract(payload,'$.serverUrl')=$2 " +
    "AND json_extract(payload,'$.status')='pending' ORDER BY json_extract(payload,'$.createdAt'),cache_key",
    [SERVER_CHAPTER_RENUMBER_PREFIX + "%", server],
  );
  return rows.map(row => parseJob(row.payload));
}

async function saveJob(job: ServerChapterRenumberJob): Promise<void> {
  await writeContentSyncCache(SERVER_CHAPTER_RENUMBER_PREFIX + job.operationId, JSON.stringify(job));
}

function sameIdentity(left: ServerChapterRenumberJob["identity"] | undefined, right: ServerChapterRenumberJob["identity"]): boolean {
  return left?.pluginId === right.pluginId && left.novelId === right.novelId && left.novelPath === right.novelPath;
}

/** Run before ordinary work pulls/uploads so old number catalogs cannot overwrite a corrected work. */
export async function reconcilePendingChapterNumbers(
  server: string,
  token: string,
  assertCurrent: () => void = () => undefined,
  uploadContent = true,
): Promise<void> {
  const pending = await listPendingChapterNumberReconciliations(server);
  if (!pending.length) return;
  const held = await readServerWorkDeletionExclusions(server);
  const jobs = pending.filter(job => !held.has(serverWorkDeletionKey(job.identity)));
  if (!jobs.length) return;
  if (!uploadContent) throw new Error("Chapter number reconciliation is pending. Run a full content synchronization before importing this work.");
  for (const job of jobs) {
    assertCurrent();
    const id = await contentWorkId(job.identity);
    if (!job.request) {
      const capabilities = await contentServerRequest<{ chapterNumberReconciliationVersion?: number }>(server, "/capabilities", token);
      assertCurrent();
      if (capabilities.chapterNumberReconciliationVersion !== 1) {
        throw new Error("Update the content server before synchronizing corrected chapter numbers.");
      }
      let snapshot: WorkMigrationSnapshot;
      try {
        snapshot = await contentServerRequest<WorkMigrationSnapshot>(server, "/works/" + id + "/migration-snapshot", token);
      } catch (error) {
        if (!(error instanceof ContentServerError && error.status === 404)) throw error;
        // A server without this work can receive the corrected catalog through ordinary upload.
        assertCurrent();
        await saveJob({ ...job, status: "completed" });
        continue;
      }
      assertCurrent();
      if (snapshot.work?.id !== id || !snapshot.work.revision || !sameIdentity(snapshot.work.identity, job.identity)) {
        throw new Error("Server chapter number snapshot does not match the local work. Synchronization was held.");
      }
      job.request = { operationId: job.operationId, expectedWorkRevision: snapshot.work.revision, mappings: job.mappings };
      await saveJob(job);
    }
    assertCurrent();
    const response = await contentServerRequest<{ operationId: string; work: WorkCatalogEntry }>(
      server, "/works/" + id + "/reconcile-chapter-numbers", token, "POST", job.request,
    );
    assertCurrent();
    if (response.operationId !== job.operationId || response.work?.id !== id ||
        !sameIdentity(response.work.metadata?.identity, job.identity)) {
      throw new Error("Server chapter number receipt does not match the saved request. Synchronization was held.");
    }
    await saveJob({ ...job, status: "completed" });
  }
}
