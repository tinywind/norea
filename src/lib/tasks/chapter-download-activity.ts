import { taskScheduler, type TaskRecord } from "./scheduler";

const pendingQueueWrites = new Map<number, number>();
const uploadAttempts = new Map<number, Set<AbortController>>();
const settledListeners = new Set<() => void>();

function isDownloading(task: TaskRecord | undefined): boolean {
  return task?.status === "queued" || task?.status === "running";
}

function deferUpload(controller: AbortController): void {
  controller.abort(new DOMException("Chapter download takes priority over upload.", "AbortError"));
}

/** Covers queued jobs before their asynchronous database write completes. */
export function beginChapterDownloadQueueWrite(chapterIds: Iterable<number>): () => void {
  const ids = new Set(chapterIds);
  for (const id of ids) {
    pendingQueueWrites.set(id, (pendingQueueWrites.get(id) ?? 0) + 1);
    for (const controller of uploadAttempts.get(id) ?? []) deferUpload(controller);
  }
  return () => {
    for (const id of ids) {
      const remaining = pendingQueueWrites.get(id)! - 1;
      if (remaining) pendingQueueWrites.set(id, remaining);
      else pendingQueueWrites.delete(id);
    }
  };
}

/** Invalidates a snapshot even if a download starts and finishes during an await. */
export function watchChapterDownloadActivity(chapterId: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const attempts = uploadAttempts.get(chapterId) ?? new Set<AbortController>();
  uploadAttempts.set(chapterId, attempts);
  attempts.add(controller);
  const unsubscribe = taskScheduler.subscribeEvents(({ task }) => {
    if (task.subject?.chapterId === chapterId &&
      (task.kind === "chapter.download" || task.kind === "chapter.repairMedia") && isDownloading(task)) {
      deferUpload(controller);
    }
  });
  if (pendingQueueWrites.has(chapterId) ||
    isDownloading(taskScheduler.getTaskByDedupeKey(`chapter.download:${chapterId}`)) ||
    isDownloading(taskScheduler.getTaskByDedupeKey(`chapter.repairMedia:${chapterId}`))) {
    deferUpload(controller);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      unsubscribe();
      attempts.delete(controller);
      if (!attempts.size) uploadAttempts.delete(chapterId);
    },
  };
}

export function notifyChapterDownloadsSettled(): void {
  for (const listener of settledListeners) listener();
}

export function subscribeChapterDownloadsSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}
