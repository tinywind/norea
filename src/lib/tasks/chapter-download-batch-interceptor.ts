import type { ChapterDownloadBatchHandle, ChapterDownloadBatchJob, ChapterDownloadJob } from "./chapter-download";
import type { TaskHandle } from "./task-types";

export interface InterceptedDownloadRecoveryState {
  keys: ReadonlySet<string>;
  sourceIds: ReadonlySet<string>;
}

interface ChapterDownloadBatchInterceptor {
  enqueue(batch: ChapterDownloadBatchJob): ChapterDownloadBatchHandle | null;
  enqueueChapter?: (job: ChapterDownloadJob) => TaskHandle<void> | null;
  cancel(batchId: string): boolean;
  isQueued?: (chapterId: number) => boolean;
  /** Returns null while the intercepted runtime is still restoring persisted jobs. */
  getRestoredRecoveryState?: () => InterceptedDownloadRecoveryState | null;
}

let interceptor: ChapterDownloadBatchInterceptor | undefined;
let recoveryReconciler: (() => void) | undefined;

export function installChapterDownloadBatchInterceptor(value: ChapterDownloadBatchInterceptor): void {
  interceptor = value;
}

export function setDownloadRecoveryReconciler(reconciler: () => void): void {
  recoveryReconciler = reconciler;
}

export function notifyInterceptedDownloadRecoveryRestored(): void {
  recoveryReconciler?.();
}

export function getInterceptedDownloadRecoveryState(): InterceptedDownloadRecoveryState | null | undefined {
  return interceptor?.getRestoredRecoveryState?.();
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
