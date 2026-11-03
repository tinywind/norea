import type { ChapterDownloadBatchHandle, ChapterDownloadBatchJob, ChapterDownloadJob } from "./chapter-download";
import type { TaskHandle } from "./task-types";

interface ChapterDownloadBatchInterceptor {
  enqueue(batch: ChapterDownloadBatchJob): ChapterDownloadBatchHandle | null;
  enqueueChapter?: (job: ChapterDownloadJob) => TaskHandle<void> | null;
  cancel(batchId: string): boolean;
  isQueued?: (chapterId: number) => boolean;
}

let interceptor: ChapterDownloadBatchInterceptor | undefined;

export function installChapterDownloadBatchInterceptor(value: ChapterDownloadBatchInterceptor): void {
  interceptor = value;
}

export function interceptChapterDownloadBatch(batch: ChapterDownloadBatchJob): ChapterDownloadBatchHandle | null {
  return interceptor?.enqueue(batch) ?? null;
}

export function interceptChapterDownload(job: ChapterDownloadJob): TaskHandle<void> | null {
  return interceptor?.enqueueChapter?.(job) ?? null;
}

export function cancelInterceptedChapterDownloadBatch(batchId: string): boolean {
  return interceptor?.cancel(batchId) ?? false;
}

export function isInterceptedChapterDownloadQueued(chapterId: number): boolean {
  return interceptor?.isQueued?.(chapterId) ?? false;
}
