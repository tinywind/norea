import type { ChapterDownloadJob } from "../../lib/tasks/chapter-download";
import {
  assertByteBudget,
  MAX_INLINE_IPC_BYTES,
} from "../../lib/performance-budgets";
import { invokeDbMutation, invokeDbQuery } from "../ipc";
import { parseStoredChapterDownloadJob } from "./vpn-download-plans";

export interface StoredQueuedChapterDownload {
  job: ChapterDownloadJob;
  jobJson: string;
  updatedAtMs: number;
}

function requireBatchId(batchId: string): void {
  if (!batchId.trim()) {
    throw new Error("A pending VPN download requires a batch identity.");
  }
}

function serializeJob(job: ChapterDownloadJob): string {
  const value = JSON.stringify(job);
  assertByteBudget(
    new TextEncoder().encode(value).byteLength,
    MAX_INLINE_IPC_BYTES,
    "Pending VPN download job",
  );
  return value;
}

export async function listOrdinaryChapterDownloadJobs(): Promise<
  StoredQueuedChapterDownload[]
> {
  return invokeDbQuery<StoredQueuedChapterDownload[]>(
    "db_download_queue_list_ordinary",
  );
}

export async function listPendingVpnDownloadJobs(): Promise<
  StoredQueuedChapterDownload[]
> {
  return invokeDbQuery<StoredQueuedChapterDownload[]>(
    "db_download_queue_list_pending_vpn",
  );
}

export async function enqueuePendingVpnDownloadJobs(
  batchId: string,
  jobs: readonly ChapterDownloadJob[],
): Promise<void> {
  requireBatchId(batchId);
  const validatedJobs = jobs.map((job) => {
    if (
      job.vpnPlanId != null ||
      job.vpnRangeId != null ||
      (job.vpnBatchId != null && job.vpnBatchId !== batchId)
    ) {
      throw new Error(`Chapter ${job.id} already has another VPN owner.`);
    }
    const jobJson = serializeJob({ ...job, vpnBatchId: batchId });
    return parseStoredChapterDownloadJob({ chapterId: job.id, jobJson });
  });
  await invokeDbMutation("db_download_queue_enqueue_pending_vpn", {
    batchId,
    jobs: validatedJobs,
  });
}

export async function adoptOrdinaryChapterDownloadJobs(
  batchId: string,
  expected: readonly StoredQueuedChapterDownload[],
): Promise<ChapterDownloadJob[]> {
  requireBatchId(batchId);
  const payload = expected.map((row) => {
    const job = parseStoredChapterDownloadJob({
      chapterId: row.job.id,
      jobJson: row.jobJson,
    });
    if (
      job.vpnBatchId != null ||
      job.vpnPlanId != null ||
      job.vpnRangeId != null
    ) {
      throw new Error(`Chapter ${job.id} no longer has ordinary ownership.`);
    }
    return {
      chapterId: job.id,
      jobJson: row.jobJson,
      updatedAtMs: row.updatedAtMs,
    };
  });
  return invokeDbMutation<ChapterDownloadJob[]>(
    "db_download_queue_adopt_ordinary",
    {
      batchId,
      expected: payload,
    },
  );
}

export async function cancelPendingVpnDownloadBatch(
  batchId: string,
): Promise<number> {
  requireBatchId(batchId);
  return invokeDbMutation<number>(
    "db_download_queue_cancel_pending_vpn_batch",
    { batchId },
  );
}

export async function cancelPendingVpnDownloadJobs(
  batchId: string,
  chapterIds: readonly number[],
): Promise<number> {
  requireBatchId(batchId);
  const ids = [...new Set(chapterIds)];
  if (ids.length === 0) return 0;
  return invokeDbMutation<number>(
    "db_download_queue_cancel_pending_vpn_jobs",
    { batchId, chapterIds: ids },
  );
}

export async function setPendingVpnDownloadJobsPaused(
  batchId: string,
  chapterIds: readonly number[],
  paused: boolean,
): Promise<number> {
  requireBatchId(batchId);
  const ids = [...new Set(chapterIds)];
  if (ids.length === 0) return 0;
  return invokeDbMutation<number>(
    "db_download_queue_set_pending_vpn_paused",
    { batchId, chapterIds: ids, paused },
  );
}
