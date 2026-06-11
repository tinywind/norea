import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  listDownloadCacheChapters,
  listDownloadCacheNovels,
} from "../../db/queries/download-cache";
import { clearChapterMedia } from "../chapter-media";
import { clearStoredChapterContentMirror } from "../chapter-content-storage";
import { isAndroidRuntime, isTauriRuntime } from "../tauri-runtime";
import {
  taskScheduler,
  type TaskHandle,
  type TaskRecord,
  type TaskRunContext,
} from "./scheduler";

const DOWNLOAD_CACHE_DELETE_PROGRESS_EVENT =
  "download-cache-delete-progress";
const ANDROID_DELETE_YIELD_INTERVAL = 10;

export type DownloadCacheDeleteScope = "chapter" | "novel" | "all";

export interface DownloadCacheDeleteWork {
  id: string;
  scope: DownloadCacheDeleteScope;
  targetIds: number[];
  title?: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  error?: string | null;
  cancelRequested: boolean;
}

export interface DownloadCacheDeleteResult {
  workId: string;
  total: number;
  deleted: number;
  failed: number;
  cancelled: boolean;
}

interface DownloadCacheDeleteProgressEvent {
  workId: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  error?: string | null;
}

export interface EnqueueDownloadCacheDeleteOptions {
  scope: DownloadCacheDeleteScope;
  targetIds?: readonly number[];
  title: string;
  progressLabel?: (completed: number, total: number) => string;
  workId?: string;
  existingWork?: DownloadCacheDeleteWork;
}

function makeDownloadCacheDeleteWorkId(): string {
  return `download-cache-delete-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function normalizeTargetIds(
  scope: DownloadCacheDeleteScope,
  targetIds: readonly number[] = [],
): number[] {
  if (scope === "all") return [];
  const ids = targetIds
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((left, right) => left - right);
  return [...new Set(ids)];
}

function taskSubjectForScope(
  scope: DownloadCacheDeleteScope,
  targetIds: readonly number[],
) {
  if (scope === "novel" && targetIds.length === 1) {
    return { novelId: targetIds[0] };
  }
  if (scope === "chapter" && targetIds.length === 1) {
    return { chapterId: targetIds[0] };
  }
  return undefined;
}

function isDownloadOrRepairTask(task: TaskRecord): boolean {
  return (
    task.kind === "chapter.download" ||
    task.kind === "chapter.repairMedia"
  );
}

function isTaskInDeleteScope(
  task: TaskRecord,
  scope: DownloadCacheDeleteScope,
  targetIds: ReadonlySet<number>,
  chapterIds: ReadonlySet<number>,
): boolean {
  if (!isDownloadOrRepairTask(task)) return false;
  if (scope === "all") return true;
  const chapterId = task.subject?.chapterId;
  if (chapterId !== undefined && chapterIds.has(chapterId)) {
    return true;
  }
  if (scope === "novel") {
    const novelId = task.subject?.novelId;
    return novelId !== undefined && targetIds.has(novelId);
  }
  return false;
}

async function removeBackendQueuedDownloads(chapterIds: number[]): Promise<void> {
  if (!isTauriRuntime() || chapterIds.length === 0) return;
  await invoke("chapter_download_queue_remove", { chapterIds });
}

async function cancelConflictingDownloads(
  scope: DownloadCacheDeleteScope,
  targetIds: readonly number[],
): Promise<void> {
  const targetIdSet = new Set(targetIds);
  const chapterIds = await chapterIdsForDownloadCacheScope(scope, targetIds);
  const chapterIdSet = new Set(chapterIds);
  const cancelledChapterIds = new Set<number>(chapterIds);
  for (const task of taskScheduler.getSnapshot().records) {
    if (!isTaskInDeleteScope(task, scope, targetIdSet, chapterIdSet)) continue;
    if (taskScheduler.cancel(task.id) && task.subject?.chapterId) {
      cancelledChapterIds.add(task.subject.chapterId);
    }
  }
  await removeBackendQueuedDownloads([...cancelledChapterIds]);
}

async function enqueueNativeWork(
  workId: string,
  scope: DownloadCacheDeleteScope,
  targetIds: readonly number[],
  title: string,
): Promise<DownloadCacheDeleteWork> {
  return invoke<DownloadCacheDeleteWork>("download_cache_delete_work_enqueue", {
    request: {
      id: workId,
      scope,
      targetIds,
      title,
    },
  });
}

async function cancelNativeWork(workId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("download_cache_delete_work_cancel", { workId });
}

async function runNativeWork(
  workId: string,
  clearFiles: boolean,
): Promise<DownloadCacheDeleteResult> {
  return invoke<DownloadCacheDeleteResult>("download_cache_delete_work_run", {
    workId,
    clearFiles,
  });
}

function progressFromEvent(
  event: DownloadCacheDeleteProgressEvent,
): { current: number; total: number } | undefined {
  if (event.total <= 0) return undefined;
  return {
    current: Math.min(event.completed, event.total),
    total: event.total,
  };
}

async function listenForNativeProgress(
  workId: string,
  context: TaskRunContext,
  progressLabel?: (completed: number, total: number) => string,
): Promise<() => void> {
  return listen<DownloadCacheDeleteProgressEvent>(
    DOWNLOAD_CACHE_DELETE_PROGRESS_EVENT,
    (event) => {
      if (event.payload.workId !== workId) return;
      const progress = progressFromEvent(event.payload);
      context.setProgress(progress);
      if (progress && progressLabel) {
        context.setDetail(progressLabel(progress.current, progress.total));
      }
    },
  );
}

async function yieldAndroidDeletion(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

async function chapterIdsForDownloadCacheScope(
  scope: DownloadCacheDeleteScope,
  targetIds: readonly number[],
): Promise<number[]> {
  if (scope === "chapter") return [...targetIds];
  if (scope === "novel") {
    const chapters = await Promise.all(
      targetIds.map((novelId) => listDownloadCacheChapters(novelId)),
    );
    return chapters.flat().map((chapter) => chapter.id);
  }
  const novels = await listDownloadCacheNovels();
  const chapters = await Promise.all(
    novels.map((novel) => listDownloadCacheChapters(novel.novelId)),
  );
  return chapters.flat().map((chapter) => chapter.id);
}

async function clearAndroidDownloadArtifacts(
  scope: DownloadCacheDeleteScope,
  targetIds: readonly number[],
  context: TaskRunContext,
  progressLabel?: (completed: number, total: number) => string,
): Promise<void> {
  const chapterIds = await chapterIdsForDownloadCacheScope(scope, targetIds);
  context.setProgress({ current: 0, total: chapterIds.length });
  for (let index = 0; index < chapterIds.length; index += 1) {
    if (context.signal.aborted) {
      throw new DOMException(
        "Download cache deletion was cancelled.",
        "AbortError",
      );
    }
    const chapterId = chapterIds[index]!;
    await clearStoredChapterContentMirror(chapterId);
    await clearChapterMedia(chapterId);
    const current = index + 1;
    context.setProgress({ current, total: chapterIds.length });
    if (progressLabel) {
      context.setDetail(progressLabel(current, chapterIds.length));
    }
    if (current % ANDROID_DELETE_YIELD_INTERVAL === 0) {
      await yieldAndroidDeletion();
    }
  }
}

async function runDownloadCacheDelete(
  work: DownloadCacheDeleteWork,
  context: TaskRunContext,
  progressLabel?: (completed: number, total: number) => string,
): Promise<DownloadCacheDeleteResult> {
  const unlisten = await listenForNativeProgress(
    work.id,
    context,
    progressLabel,
  );
  const abortListener = () => {
    void cancelNativeWork(work.id);
  };
  context.signal.addEventListener("abort", abortListener, { once: true });
  try {
    if (isAndroidRuntime()) {
      await clearAndroidDownloadArtifacts(
        work.scope,
        work.targetIds,
        context,
        progressLabel,
      );
      return await runNativeWork(work.id, false);
    }
    return await runNativeWork(work.id, true);
  } finally {
    context.signal.removeEventListener("abort", abortListener);
    unlisten();
  }
}

export function enqueueDownloadCacheDelete({
  existingWork,
  progressLabel,
  scope,
  targetIds: requestedTargetIds = [],
  title,
  workId,
}: EnqueueDownloadCacheDeleteOptions): TaskHandle<DownloadCacheDeleteResult> {
  const targetIds = existingWork
    ? existingWork.targetIds
    : normalizeTargetIds(scope, requestedTargetIds);
  const id = existingWork?.id ?? workId ?? makeDownloadCacheDeleteWorkId();
  const resolvedScope = existingWork?.scope ?? scope;
  const resolvedTitle = existingWork?.title ?? title;

  return taskScheduler.enqueueMain<DownloadCacheDeleteResult>({
    kind: "maintenance.clearDownloadedContent",
    priority: "user",
    title: resolvedTitle,
    subject: taskSubjectForScope(resolvedScope, targetIds),
    dedupeKey: `download-cache-delete:${id}`,
    run: async (context) => {
      await cancelConflictingDownloads(resolvedScope, targetIds);
      const work =
        existingWork ??
        (await enqueueNativeWork(id, resolvedScope, targetIds, resolvedTitle));
      return runDownloadCacheDelete(work, context, progressLabel);
    },
  });
}

export async function startDownloadCacheDeleteWorkExecutor(
  title: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const works = await invoke<DownloadCacheDeleteWork[]>(
    "download_cache_delete_work_list_resumable",
  );
  for (const work of works) {
    enqueueDownloadCacheDelete({
      existingWork: work,
      scope: work.scope,
      title: work.title ?? title,
    });
  }
}
