import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getChapterById } from "../../db/queries/chapter";
import {
  listNonLocalDownloadCacheDeleteChapters,
  type DownloadCacheDeleteChapterCandidate,
} from "../../db/queries/download-cache";
import { getNovelById } from "../../db/queries/novel";
import {
  deleteAndroidStoragePath,
  listAndroidChapterStorageDirs,
} from "../android-storage";
import {
  chapterStorageIdentityPrefix,
  chapterStorageRelativeDir,
  novelStorageIdentitySuffix,
  sourceStorageRelativeDir,
} from "../chapter-storage-path";
import { pluginManager } from "../plugins/manager";
import { validateChapterAcquisitionPlan } from "../plugins/chapter-acquisition";
import { forgetResolvedChapterStorageDir } from "../chapter-storage-resolution";
import { isAndroidRuntime, isTauriRuntime } from "../tauri-runtime";
import {
  invalidateChapterPageCache,
  type ChapterPageCacheEntry,
} from "../webview-cache";
import { waitForChapterDownloadQueueMutations } from "./chapter-download";
import {
  taskScheduler,
  type TaskHandle,
  type TaskRecord,
  type TaskRunContext,
} from "./scheduler";
import { runExclusiveChapterStorageOperation } from "./chapter-storage-operation";

const DOWNLOAD_CACHE_DELETE_PROGRESS_EVENT =
  "download-cache-delete-progress";
const ANDROID_DELETE_YIELD_INTERVAL = 10;
const PAGE_CACHE_RESOLUTION_YIELD_INTERVAL = 25;

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
): Promise<DownloadCacheDeleteChapterCandidate[]> {
  const targetIdSet = new Set(targetIds);
  const chapters = await chaptersForDownloadCacheScope(scope, targetIds);
  const chapterIds = chapters.map((chapter) => chapter.id);
  const chapterIdSet = new Set(chapterIds);
  const cancelledChapterIds = new Set<number>(chapterIds);
  await waitForChapterDownloadQueueMutations();
  await removeBackendQueuedDownloads([...cancelledChapterIds]);
  const conflictingTaskIds: string[] = [];
  for (const task of taskScheduler.getSnapshot().records) {
    if (!isTaskInDeleteScope(task, scope, targetIdSet, chapterIdSet)) continue;
    conflictingTaskIds.push(task.id);
    if (taskScheduler.cancel(task.id) && task.subject?.chapterId) {
      cancelledChapterIds.add(task.subject.chapterId);
    }
  }
  await Promise.all(
    conflictingTaskIds.map((taskId) =>
      taskScheduler.waitForSourceTaskSettlement(taskId),
    ),
  );
  await waitForChapterDownloadQueueMutations();
  await removeBackendQueuedDownloads([...cancelledChapterIds]);
  return chaptersForDownloadCacheScope(scope, targetIds);
}

export async function cancelNovelChapterDownloadWork(
  novelIds: readonly number[],
): Promise<void> {
  const targetIds = normalizeTargetIds("novel", novelIds);
  if (targetIds.length === 0) return;
  await cancelConflictingDownloads("novel", targetIds);
}

async function chapterPageCacheEntriesForDelete(
  chapters: readonly DownloadCacheDeleteChapterCandidate[],
  signal: AbortSignal,
): Promise<ChapterPageCacheEntry[]> {
  if (chapters.length === 0) return [];
  let pluginRefreshFailed = false;
  if (isTauriRuntime()) {
    try {
      await pluginManager.loadInstalledFromDb();
    } catch (error) {
      pluginRefreshFailed = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[download-cache-delete] failed to refresh installed plugins before page cache invalidation:",
        error,
      );
    }
  }
  const entries = new Map<string, ChapterPageCacheEntry>();
  const sourceFallbacks = new Set(
    pluginRefreshFailed
      ? chapters
          .filter(
            (chapter) => chapter.isDownloaded || chapter.contentBytes > 0,
          )
          .map((chapter) => chapter.pluginId)
      : [],
  );
  for (let index = 0; index < chapters.length; index += 1) {
    throwIfDownloadCacheDeleteAborted(signal);
    if (index > 0 && index % PAGE_CACHE_RESOLUTION_YIELD_INTERVAL === 0) {
      await yieldDownloadCacheDelete();
      throwIfDownloadCacheDeleteAborted(signal);
    }
    const chapter = chapters[index]!;
    if (!chapter.isDownloaded && chapter.contentBytes <= 0) continue;
    if (sourceFallbacks.has(chapter.pluginId)) continue;
    const plugin = pluginManager.getPlugin(chapter.pluginId);
    if (!plugin) {
      sourceFallbacks.add(chapter.pluginId);
      continue;
    }
    let plan;
    try {
      plan = validateChapterAcquisitionPlan(
        plugin.getChapterAcquisitionPlan(
          chapter.path,
          chapter.sourceContentType,
        ),
      );
    } catch {
      sourceFallbacks.add(chapter.pluginId);
      continue;
    }
    if (plan.type !== "page") continue;
    const entry = { sourceId: chapter.pluginId, url: plan.url };
    entries.set(`${entry.sourceId}\n${entry.url}`, entry);
  }
  return [
    ...[...sourceFallbacks].map((sourceId) => ({ sourceId })),
    ...[...entries.values()].filter(
      (entry) => !sourceFallbacks.has(entry.sourceId),
    ),
  ];
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

async function yieldDownloadCacheDelete(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function throwIfDownloadCacheDeleteAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw (
    signal.reason ??
    new DOMException("Download cache deletion was cancelled.", "AbortError")
  );
}

async function chaptersForDownloadCacheScope(
  scope: DownloadCacheDeleteScope,
  targetIds: readonly number[],
): Promise<DownloadCacheDeleteChapterCandidate[]> {
  if (scope === "chapter") {
    return listNonLocalDownloadCacheDeleteChapters({
      chapterIds: targetIds,
    });
  }
  if (scope === "novel") {
    return listNonLocalDownloadCacheDeleteChapters({ novelIds: targetIds });
  }
  return listNonLocalDownloadCacheDeleteChapters();
}

async function clearAndroidChapterArtifacts(chapterId: number): Promise<void> {
  const chapter = await getChapterById(chapterId);
  const novel = chapter ? await getNovelById(chapter.novelId) : null;
  if (chapter && novel && !novel.isLocal) {
    const preferredChapterDir = chapterStorageRelativeDir(novel, chapter);
    const chapterDirs = await listAndroidChapterStorageDirs({
      preferredChapterDir,
      sourceDir: sourceStorageRelativeDir(novel),
      novelIdentitySuffix: novelStorageIdentitySuffix(novel),
      chapterIdentityPrefix: chapterStorageIdentityPrefix(chapter),
    });
    if (chapterDirs.length > 1) {
      throw new Error(
        `Multiple stored chapter folders match chapter ${chapterId}; delete the intended chapter folders manually.`,
      );
    }
    for (const chapterDir of new Set([
      ...chapterDirs,
      preferredChapterDir,
    ])) {
      await deleteAndroidStoragePath(chapterDir);
    }
  }
  await deleteAndroidStoragePath(`chapter-media/${chapterId}`);
  forgetResolvedChapterStorageDir(chapterId);
}

async function clearAndroidDownloadArtifacts(
  scope: DownloadCacheDeleteScope,
  targetIds: readonly number[],
  context: TaskRunContext,
  progressLabel?: (completed: number, total: number) => string,
): Promise<void> {
  const chapters = await chaptersForDownloadCacheScope(scope, targetIds);
  const chapterIds = chapters.map((chapter) => chapter.id);
  context.setProgress({ current: 0, total: chapterIds.length });
  for (let index = 0; index < chapterIds.length; index += 1) {
    if (context.signal.aborted) {
      throw new DOMException(
        "Download cache deletion was cancelled.",
        "AbortError",
      );
    }
    const chapterId = chapterIds[index]!;
    await clearAndroidChapterArtifacts(chapterId);
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
  let cancellation: Promise<void> | undefined;
  const requestCancellation = () => {
    if (!cancellation) {
      cancellation = cancelNativeWork(work.id);
      void cancellation.catch(() => undefined);
    }
    return cancellation;
  };
  const abortListener = () => {
    void requestCancellation();
  };
  context.signal.addEventListener("abort", abortListener, { once: true });
  let unlisten: (() => void) | undefined;
  try {
    if (context.signal.aborted) {
      await requestCancellation();
      throwIfDownloadCacheDeleteAborted(context.signal);
    }
    unlisten = await listenForNativeProgress(
      work.id,
      context,
      progressLabel,
    );
    if (context.signal.aborted) {
      await requestCancellation();
      throwIfDownloadCacheDeleteAborted(context.signal);
    }
    if (isAndroidRuntime()) {
      await clearAndroidDownloadArtifacts(
        work.scope,
        work.targetIds,
        context,
        progressLabel,
      );
      const result = await runNativeWork(work.id, false);
      throwIfDownloadCacheDeleteAborted(context.signal);
      return result;
    }
    const result = await runNativeWork(work.id, true);
    throwIfDownloadCacheDeleteAborted(context.signal);
    return result;
  } finally {
    context.signal.removeEventListener("abort", abortListener);
    unlisten?.();
    if (cancellation) await cancellation;
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
      let enteredStorageOperation = false;
      try {
        return await runExclusiveChapterStorageOperation(
          { kind: "all" },
          context.signal,
          async () => {
            enteredStorageOperation = true;
            const chapters = await cancelConflictingDownloads(
              resolvedScope,
              targetIds,
            );
            const chapterPageCacheEntries =
              await chapterPageCacheEntriesForDelete(
                chapters,
                context.signal,
              );
            if (context.signal.aborted && existingWork) {
              await cancelNativeWork(existingWork.id);
            }
            throwIfDownloadCacheDeleteAborted(context.signal);
            if (chapterPageCacheEntries.length > 0) {
              await invalidateChapterPageCache(
                chapterPageCacheEntries,
                context.signal,
              );
            }
            throwIfDownloadCacheDeleteAborted(context.signal);
            const work =
              existingWork ??
              (await enqueueNativeWork(
                id,
                resolvedScope,
                targetIds,
                resolvedTitle,
              ));
            let deletionFailure: { error: unknown } | undefined;
            try {
              return await runDownloadCacheDelete(
                work,
                context,
                progressLabel,
              );
            } catch (error) {
              deletionFailure = { error };
              throw error;
            } finally {
              if (chapterPageCacheEntries.length > 0) {
                try {
                  await invalidateChapterPageCache(chapterPageCacheEntries);
                } catch (invalidationError) {
                  if (deletionFailure) {
                    const deletionErrorMessage =
                      deletionFailure.error instanceof Error
                        ? deletionFailure.error.message
                        : String(deletionFailure.error);
                    const invalidationErrorMessage =
                      invalidationError instanceof Error
                        ? invalidationError.message
                        : String(invalidationError);
                    throw new AggregateError(
                      [deletionFailure.error, invalidationError],
                      `Download cache deletion failed: ${deletionErrorMessage}. Chapter page cache cleanup also failed: ${invalidationErrorMessage}.`,
                    );
                  }
                  throw invalidationError;
                }
              }
            }
          },
        );
      } catch (error) {
        if (!enteredStorageOperation && context.signal.aborted && existingWork) {
          await cancelNativeWork(existingWork.id);
        }
        throw error;
      }
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
