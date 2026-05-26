import {
  listDownloadCacheMediaBackfillCandidates,
  updateDownloadCacheChapterMediaBytes,
} from "../db/queries/download-cache";
import { readStoredChapterContentMirror } from "./chapter-content-storage";
import { getStoredChapterMediaBytes } from "./chapter-media";
import {
  MAX_BACKFILL_PER_RUN,
  clampBackfillLimit,
} from "./performance-budgets";
import {
  recordPerformanceObservation,
  startPerformanceObservation,
} from "./observability";
import { isTauriRuntime } from "./tauri-runtime";

const scheduledBackfills = new Set<string>();

export interface DownloadCacheMediaBackfillResult {
  candidateCount: number;
  limit: number;
  novelId?: number;
  processedChapters: number;
  skipped: boolean;
  updatedChapters: number;
}

function backfillKey(novelId: number | undefined, limit: number): string {
  return `${novelId ?? "all"}:${limit}`;
}

export async function backfillDownloadCacheMediaBytes(
  novelId?: number,
  options: { limit?: number } = {},
): Promise<DownloadCacheMediaBackfillResult> {
  const limit = clampBackfillLimit(options.limit ?? MAX_BACKFILL_PER_RUN);
  if (!isTauriRuntime()) {
    recordPerformanceObservation("download-cache.backfill", {
      limit,
      novelId,
      skipped: true,
    });
    return {
      candidateCount: 0,
      limit,
      novelId,
      processedChapters: 0,
      skipped: true,
      updatedChapters: 0,
    };
  }

  const finish = startPerformanceObservation("download-cache.backfill", {
    limit,
    novelId,
  });
  let processed = 0;
  let updated = 0;
  const candidates = await listDownloadCacheMediaBackfillCandidates(
    novelId,
    limit,
  );
  for (const candidate of candidates) {
    try {
      const content = await readStoredChapterContentMirror(candidate.id);
      if (content === null) {
        continue;
      }
      const mediaBytes = await getStoredChapterMediaBytes(content, {
        chapterId: candidate.id,
        chapterName: candidate.chapterName,
        chapterNumber: candidate.chapterNumber,
        chapterPosition: candidate.position,
        novelId: candidate.novelId,
        novelName: candidate.novelName,
        novelPath: candidate.novelPath,
        sourceId: candidate.pluginId,
      });
      const result = await updateDownloadCacheChapterMediaBytes(
        candidate.id,
        mediaBytes,
      );
      processed += 1;
      updated += result.rowsAffected > 0 ? 1 : 0;
    } catch (error) {
      finish({
        candidateCount: candidates.length,
        error: error instanceof Error ? error.message : String(error),
        failed: true,
        processed,
      });
      throw error;
    }
  }
  const result = {
    candidateCount: candidates.length,
    limit,
    novelId,
    processedChapters: processed,
    skipped: false,
    updatedChapters: updated,
  };
  finish({ ...result, processed, updated });
  return result;
}

export function scheduleDownloadCacheMediaBytesBackfill(
  novelId?: number,
  options: {
    limit?: number;
    onComplete?: (result: DownloadCacheMediaBackfillResult) => void;
    onSettled?: () => void;
  } = {},
): void {
  const limit = clampBackfillLimit(options.limit ?? MAX_BACKFILL_PER_RUN);
  const key = backfillKey(novelId, limit);
  if (scheduledBackfills.has(key)) return;

  scheduledBackfills.add(key);
  void backfillDownloadCacheMediaBytes(novelId, { limit })
    .then((result) => {
      options.onComplete?.(result);
    })
    .catch((error) => {
      recordPerformanceObservation("download-cache.backfill", {
        background: true,
        error: error instanceof Error ? error.message : String(error),
        failed: true,
        limit,
        novelId,
      });
    })
    .finally(() => {
      scheduledBackfills.delete(key);
      options.onSettled?.();
    });
}

export function resetDownloadCacheMediaBackfillSchedulerForTests(): void {
  scheduledBackfills.clear();
}
