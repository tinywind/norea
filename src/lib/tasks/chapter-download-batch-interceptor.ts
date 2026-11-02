import type { ChapterDownloadBatchHandle, ChapterDownloadBatchJob } from "./chapter-download";

interface ChapterDownloadBatchInterceptor {
  enqueue(batch: ChapterDownloadBatchJob): ChapterDownloadBatchHandle | null;
  cancel(batchId: string): boolean;
}

let interceptor: ChapterDownloadBatchInterceptor | undefined;

export function installChapterDownloadBatchInterceptor(value: ChapterDownloadBatchInterceptor): void {
  interceptor = value;
}

export function interceptChapterDownloadBatch(batch: ChapterDownloadBatchJob): ChapterDownloadBatchHandle | null {
  return interceptor?.enqueue(batch) ?? null;
}

export function cancelInterceptedChapterDownloadBatch(batchId: string): boolean {
  return interceptor?.cancel(batchId) ?? false;
}
