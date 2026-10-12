import { invoke } from "@tauri-apps/api/core";
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
import { forgetResolvedChapterStorageDir, resolvedChapterStorageDir } from "../chapter-storage-resolution";
import { waitForChapterDownloadWrites, withChapterDownloadDeletion } from "../chapter-download-writes";
import { isAndroidRuntime, isTauriRuntime } from "../tauri-runtime";
import {
  discardQueuedChapterDownloads,
  waitForChapterDownloadQueueMutations,
} from "./chapter-download";
import { taskScheduler, type TaskRecord } from "./scheduler";

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

const activeDeletions = new Map<string, Promise<DownloadCacheDeleteResult>>();

export interface DownloadCacheDeleteOptions {
  scope: DownloadCacheDeleteScope;
  targetIds?: readonly number[];
  title: string;
  workId?: string;
  existingWork?: DownloadCacheDeleteWork;
  signal?: AbortSignal;
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

async function yieldAndroidDeletion(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
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
    const knownDirectory = resolvedChapterStorageDir(chapterId);
    const chapterDirs = knownDirectory ? [knownDirectory] : await listAndroidChapterStorageDirs({
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
  signal: AbortSignal,
): Promise<void> {
  const chapters = await chaptersForDownloadCacheScope(scope, targetIds);
  const chapterIds = chapters.map((chapter) => chapter.id);
  for (let index = 0; index < chapterIds.length; index += 1) {
    throwIfDownloadCacheDeleteAborted(signal);
    const chapterId = chapterIds[index]!;
    await clearAndroidChapterArtifacts(chapterId);
    const current = index + 1;
    if (current % ANDROID_DELETE_YIELD_INTERVAL === 0) {
      await yieldAndroidDeletion();
    }
  }
}

async function runDownloadCacheDelete(
  work: DownloadCacheDeleteWork,
  signal: AbortSignal,
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
  signal.addEventListener("abort", abortListener, { once: true });
  try {
    if (signal.aborted) {
      await requestCancellation();
      throwIfDownloadCacheDeleteAborted(signal);
    }
    if (isAndroidRuntime()) {
      await clearAndroidDownloadArtifacts(
        work.scope,
        work.targetIds,
        signal,
      );
      throwIfDownloadCacheDeleteAborted(signal);
      const result = await runNativeWork(work.id, false);
      throwIfDownloadCacheDeleteAborted(signal);
      return result;
    }
    const result = await runNativeWork(work.id, true);
    throwIfDownloadCacheDeleteAborted(signal);
    return result;
  } finally {
    signal.removeEventListener("abort", abortListener);
    if (cancellation) await cancellation;
  }
}

export async function deleteDownloadCache({
  existingWork,
  scope,
  targetIds: requestedTargetIds = [],
  title,
  workId,
  signal = new AbortController().signal,
}: DownloadCacheDeleteOptions): Promise<DownloadCacheDeleteResult> {
  const targetIds = existingWork
    ? existingWork.targetIds
    : normalizeTargetIds(scope, requestedTargetIds);
  const id = existingWork?.id ?? workId ?? makeDownloadCacheDeleteWorkId();
  const resolvedScope = existingWork?.scope ?? scope;
  const resolvedTitle = existingWork?.title ?? title;
  const active = activeDeletions.get(id);
  if (active) return active;

  const deletion = (async () => {
    let runningWork = false;
    try {
      throwIfDownloadCacheDeleteAborted(signal);
      const chapters = await chaptersForDownloadCacheScope(resolvedScope, targetIds);
      throwIfDownloadCacheDeleteAborted(signal);
      const targetIdSet = new Set(targetIds);
      const chapterIds = new Set(chapters.map((chapter) => chapter.id));
      if (resolvedScope === "chapter") {
        for (const chapterId of targetIds) chapterIds.add(chapterId);
      }
      const tasks = taskScheduler.getSnapshot().records.filter((task) =>
        isTaskInDeleteScope(task, resolvedScope, targetIdSet, chapterIds),
      );
      for (const task of tasks) {
        if (task.subject?.chapterId) chapterIds.add(task.subject.chapterId);
      }
      return await withChapterDownloadDeletion([...chapterIds], async () => {
        discardQueuedChapterDownloads([...chapterIds]);
        for (const task of tasks) taskScheduler.cancel(task.id);
        await waitForChapterDownloadWrites([...chapterIds]);
        await removeBackendQueuedDownloads([...chapterIds]);
        throwIfDownloadCacheDeleteAborted(signal);
        const work = existingWork ?? await enqueueNativeWork(
          id,
          resolvedScope,
          targetIds,
          resolvedTitle,
        );
        runningWork = true;
        return await runDownloadCacheDelete(work, signal);
      });
    } catch (error) {
      if (!runningWork && signal.aborted && existingWork) {
        await cancelNativeWork(existingWork.id);
      }
      throw error;
    }
  })();
  activeDeletions.set(id, deletion);
  try {
    return await deletion;
  } finally {
    activeDeletions.delete(id);
  }
}

export async function startDownloadCacheDeleteWorkExecutor(
  title: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const works = await invoke<DownloadCacheDeleteWork[]>(
    "download_cache_delete_work_list_resumable",
  );
  await Promise.all(works.map((work) =>
    deleteDownloadCache({
      existingWork: work,
      scope: work.scope,
      title: work.title ?? title,
    }),
  ));
}
