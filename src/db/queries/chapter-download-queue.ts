import type { ChapterDownloadJob } from "../../lib/tasks/chapter-download";
import { assertByteBudget, MAX_INLINE_IPC_BYTES, MAX_ROUTE_QUERY_ROWS } from "../../lib/performance-budgets";
import { getDb, runDatabaseTransaction } from "../client";
import { parseStoredChapterDownloadJob } from "./vpn-download-plans";

export interface StoredQueuedChapterDownload {
  job: ChapterDownloadJob;
  jobJson: string;
  updatedAtMs: number;
}

interface QueueRow {
  chapterId: number;
  jobJson: string;
  updatedAtMs: number;
}

function requireBatchId(batchId: string): void {
  if (!batchId.trim()) throw new Error("A pending VPN download requires a batch identity.");
}

function serializeJob(job: ChapterDownloadJob): string {
  const value = JSON.stringify(job);
  assertByteBudget(new TextEncoder().encode(value).byteLength, MAX_INLINE_IPC_BYTES, "Pending VPN download job");
  return value;
}

function storedJob(row: QueueRow): StoredQueuedChapterDownload {
  return { job: parseStoredChapterDownloadJob(row), jobJson: row.jobJson, updatedAtMs: row.updatedAtMs };
}

export async function listOrdinaryChapterDownloadJobs(): Promise<StoredQueuedChapterDownload[]> {
  const db = await getDb();
  const rows = await db.select<QueueRow[]>(
    `SELECT q.chapter_id AS chapterId,q.job_json AS jobJson,q.updated_at_ms AS updatedAtMs
     FROM chapter_download_queue q JOIN chapter c ON c.id=q.chapter_id JOIN novel n ON n.id=c.novel_id
     WHERE n.is_local=0 AND n.id=json_extract(q.job_json,'$.novelId') AND n.plugin_id=json_extract(q.job_json,'$.pluginId')
       AND json_extract(q.job_json,'$.serverOnly') IS NOT 1
       AND json_extract(q.job_json,'$.vpnBatchId') IS NULL
       AND json_extract(q.job_json,'$.vpnPlanId') IS NULL AND json_extract(q.job_json,'$.vpnRangeId') IS NULL
     ORDER BY q.created_at_ms,q.chapter_id`,
  );
  return rows.map(storedJob);
}

export async function listPendingVpnDownloadJobs(): Promise<StoredQueuedChapterDownload[]> {
  const db = await getDb();
  const rows = await db.select<QueueRow[]>(
    `SELECT chapter_id AS chapterId,job_json AS jobJson,updated_at_ms AS updatedAtMs
     FROM chapter_download_queue WHERE json_extract(job_json,'$.vpnBatchId') IS NOT NULL
       AND json_extract(job_json,'$.vpnPlanId') IS NULL AND json_extract(job_json,'$.vpnRangeId') IS NULL
     ORDER BY created_at_ms,chapter_id`,
  );
  return rows.map(storedJob);
}

export async function enqueuePendingVpnDownloadJobs(batchId: string, jobs: readonly ChapterDownloadJob[]): Promise<void> {
  requireBatchId(batchId);
  const captured = jobs.map(job => {
    if (job.serverOnly) throw new Error("Content server downloads cannot enter the source VPN queue.");
    if (job.vpnPlanId != null || job.vpnRangeId != null || (job.vpnBatchId != null && job.vpnBatchId !== batchId)) {
      throw new Error(`Chapter ${job.id} already has another VPN owner.`);
    }
    const jobJson = serializeJob({ ...job, vpnBatchId: batchId });
    return { job: parseStoredChapterDownloadJob({ chapterId: job.id, jobJson }), jobJson };
  });
  await runDatabaseTransaction(async db => {
    const now = Date.now();
    for (const { job, jobJson } of captured) {
      const [existing] = await db.select<QueueRow[]>(
        "SELECT chapter_id AS chapterId,job_json AS jobJson,updated_at_ms AS updatedAtMs FROM chapter_download_queue WHERE chapter_id=$1", [job.id],
      );
      if (existing) {
        const owner = parseStoredChapterDownloadJob(existing);
        if (owner.vpnBatchId !== batchId || owner.vpnPlanId != null || owner.vpnRangeId != null || serializeJob(owner) !== jobJson) {
          throw new Error(`Chapter ${job.id} conflicts with an existing download owner.`);
        }
        continue;
      }
      await db.execute(
        "INSERT INTO chapter_download_queue(chapter_id,job_json,created_at_ms,updated_at_ms,leased_at_ms,attempt_count) VALUES($1,$2,$3,$3,NULL,0)",
        [job.id, jobJson, now],
      );
    }
  });
}

export async function adoptOrdinaryChapterDownloadJobs(
  batchId: string, expected: readonly StoredQueuedChapterDownload[],
): Promise<ChapterDownloadJob[]> {
  requireBatchId(batchId);
  const captured = expected.map(row => {
    const job = parseStoredChapterDownloadJob({ chapterId: row.job.id, jobJson: row.jobJson });
    if (job.serverOnly) throw new Error("Content server downloads cannot enter the source VPN queue.");
    if (job.vpnBatchId != null || job.vpnPlanId != null || job.vpnRangeId != null) {
      throw new Error(`Chapter ${job.id} no longer has ordinary ownership.`);
    }
    return { ...row, job: { ...job, vpnBatchId: batchId } };
  });
  return runDatabaseTransaction(async db => {
    const now = Date.now();
    for (const row of captured) {
      const result = await db.execute(
        `UPDATE chapter_download_queue SET job_json=$1,updated_at_ms=$2,leased_at_ms=NULL
         WHERE chapter_id=$3 AND job_json=$4 AND updated_at_ms=$5
           AND json_extract(job_json,'$.serverOnly') IS NOT 1
           AND json_extract(job_json,'$.vpnBatchId') IS NULL
           AND json_extract(job_json,'$.vpnPlanId') IS NULL AND json_extract(job_json,'$.vpnRangeId') IS NULL
           AND EXISTS(SELECT 1 FROM chapter c JOIN novel n ON n.id=c.novel_id
             WHERE c.id=chapter_download_queue.chapter_id AND n.is_local=0
               AND n.id=json_extract(job_json,'$.novelId') AND n.plugin_id=json_extract(job_json,'$.pluginId'))`,
        [serializeJob(row.job), now, row.job.id, row.jobJson, row.updatedAtMs],
      );
      if (result.rowsAffected !== 1) throw new Error(`Queued chapter ${row.job.id} is missing, stale or changed owners.`);
    }
    return captured.map(row => row.job);
  });
}

export async function cancelPendingVpnDownloadBatch(batchId: string): Promise<number> {
  requireBatchId(batchId);
  return runDatabaseTransaction(async db => {
    const result = await db.execute(
      `DELETE FROM chapter_download_queue WHERE json_extract(job_json,'$.vpnBatchId')=$1
       AND json_extract(job_json,'$.vpnPlanId') IS NULL AND json_extract(job_json,'$.vpnRangeId') IS NULL`, [batchId],
    );
    return result.rowsAffected;
  });
}

export async function cancelPendingVpnDownloadJobs(batchId: string, chapterIds: readonly number[]): Promise<number> {
  requireBatchId(batchId);
  const ids = [...new Set(chapterIds)];
  return runDatabaseTransaction(async db => {
    let cancelled = 0;
    const chunkSize = MAX_ROUTE_QUERY_ROWS - 1;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      const result = await db.execute(
        `DELETE FROM chapter_download_queue WHERE json_extract(job_json,'$.vpnBatchId')=$1
         AND json_extract(job_json,'$.vpnPlanId') IS NULL AND json_extract(job_json,'$.vpnRangeId') IS NULL
         AND chapter_id IN (${chunk.map((_, index) => `$${index + 2}`).join(",")})`, [batchId, ...chunk],
      );
      cancelled += result.rowsAffected;
    }
    return cancelled;
  });
}

export async function setPendingVpnDownloadJobsPaused(batchId: string, chapterIds: readonly number[], paused: boolean): Promise<number> {
  requireBatchId(batchId);
  const ids = [...new Set(chapterIds)];
  return runDatabaseTransaction(async db => {
    let changed = 0;
    const chunkSize = MAX_ROUTE_QUERY_ROWS - 2;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      const payload = paused ? "json_set(job_json,'$.vpnWorkPaused',json('true'))" : "json_remove(job_json,'$.vpnWorkPaused')";
      const result = await db.execute(
        `UPDATE chapter_download_queue SET job_json=${payload},updated_at_ms=$2
         WHERE json_extract(job_json,'$.vpnBatchId')=$1 AND json_extract(job_json,'$.vpnPlanId') IS NULL
           AND json_extract(job_json,'$.vpnRangeId') IS NULL
           AND chapter_id IN (${chunk.map((_, index) => `$${index + 3}`).join(",")})`, [batchId, Date.now(), ...chunk],
      );
      changed += result.rowsAffected;
    }
    return changed;
  });
}
