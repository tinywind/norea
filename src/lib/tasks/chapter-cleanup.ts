import { invoke } from "@tauri-apps/api/core";
import { listChapterCleanupCandidates, reconcileCleanedChapter, type ChapterCleanupCandidate } from "../../db/queries/chapter-cleanup";
import { useContentSyncStore } from "../../store/content-sync";
import {
  chapterCleanupInventorySkip,
  cleanupServerFailure,
  type ChapterCleanupFilters,
  type ChapterCleanupPreview,
  type ChapterCleanupTarget,
} from "../chapter-cleanup";
import {
  deleteChapterPayload,
  deleteChapterPayloadFast,
  inspectChapterPayloadInventory,
} from "../chapter-content/storage-platform";
import { waitForChapterDownloadWrites, withChapterDownloadDeletion } from "../chapter-download-writes";
import {
  cleanupServerUrl,
  fetchCleanupServerInventory,
  verifyServerCompleteChapter,
  type ServerCompleteChapter,
} from "../content-sync/chapter-inventory";
import { hasPendingReplaceServerUpload } from "../content-sync/sync";
import { runWorkContentStorageOperation } from "../content-sync/storage-operation";
import { getActiveReaderChapterIds } from "../reader-active-chapters";
import { isTauriRuntime } from "../tauri-runtime";
import { listGoalProtectedChapterIds } from "../download-goals/goal-protection";
import { cancelChapterDownloadTasks, discardQueuedChapterDownloads, waitForChapterDownloadQueueMutations } from "./chapter-download";
import { taskScheduler, type TaskHandle, type TaskPriority } from "./scheduler";
import { isTaskUserCancelledError } from "./task-errors";

export interface ChapterCleanupTargetResult {
  chapterId: number;
  status: "deleted" | "skipped" | "failed";
  reason?: string;
}
export interface ChapterCleanupResult {
  total: number;
  deleted: number;
  skipped: number;
  failed: number;
  cancelled: number;
  bytesFreed: number;
  results: ChapterCleanupTargetResult[];
}
interface ChapterCleanupRunOptions {
  signal?: AbortSignal;
  onProgress?: (result: ChapterCleanupResult) => void;
}

function sameCandidate(left: ChapterCleanupCandidate, right: ChapterCleanupCandidate): boolean {
  return left.identity.novel.id === right.identity.novel.id && left.identity.novel.pluginId === right.identity.novel.pluginId
    && left.identity.novel.sourceNovelId === right.identity.novel.sourceNovelId && left.novelPath === right.novelPath
    && left.chapterPath === right.chapterPath && left.identity.chapter.chapterNumber === right.identity.chapter.chapterNumber
    && left.identity.chapter.position === right.identity.chapter.position && left.identity.chapter.contentType === right.identity.chapter.contentType
    && left.serverSource === right.serverSource && left.localServerFingerprint === right.localServerFingerprint
    && left.progress === right.progress;
}

async function eligibilityFailure(
  preview: ChapterCleanupPreview,
  target: ChapterCleanupTarget,
): Promise<"active-reader" | "changed" | "ambiguous-storage" | null> {
  const chapterId = target.candidate.identity.chapter.id;
  if (getActiveReaderChapterIds().has(chapterId)) return "active-reader";
  if (preview.filters.server !== "any" && useContentSyncStore.getState().serverUrl !== preview.serverSetting) return "changed";
  const rows = await listChapterCleanupCandidates(preview.filters, { chapterId, readMode: "queued" });
  if (rows.length !== 1 || !sameCandidate(rows[0]!, target.candidate)) return "changed";
  if (preview.filters.finished) {
    const protectedIds = await listGoalProtectedChapterIds([target.candidate.identity.novel.id]);
    if (protectedIds.has(chapterId)) return "changed";
  }
  return rows[0]!.storageAmbiguous ? "ambiguous-storage" : null;
}

async function finishedEligibilityFailure(
  filters: ChapterCleanupFilters,
  serverSetting: string,
  candidate: ChapterCleanupCandidate,
): Promise<"active-reader" | "changed" | "ambiguous-storage" | null> {
  const chapterId = candidate.identity.chapter.id;
  if (getActiveReaderChapterIds().has(chapterId)) return "active-reader";
  if (filters.server !== "any" && useContentSyncStore.getState().serverUrl !== serverSetting) return "changed";
  const rows = await listChapterCleanupCandidates(filters, { chapterId, readMode: "queued" });
  if (rows.length !== 1 || !sameCandidate(rows[0]!, candidate)) return "changed";
  const protectedIds = await listGoalProtectedChapterIds([candidate.identity.novel.id]);
  if (protectedIds.has(chapterId)) return "changed";
  return rows[0]!.storageAmbiguous ? "ambiguous-storage" : null;
}

export async function runChapterCleanup(preview: ChapterCleanupPreview, options: ChapterCleanupRunOptions = {}): Promise<ChapterCleanupResult> {
  const { signal, onProgress } = options;
  const result: ChapterCleanupResult = { total: preview.targets.length, deleted: 0, skipped: 0, failed: 0, cancelled: 0, bytesFreed: 0, results: [] };
  let lastProgress = 0;
  for (const target of preview.targets) {
    if (signal?.aborted) break;
    const candidate = target.candidate;
    const chapterId = candidate.identity.chapter.id;
    let entry: ChapterCleanupTargetResult;
    let mutationStarted = false;
    try {
      const initialFailure = await eligibilityFailure(preview, target);
      if (initialFailure) entry = { chapterId, status: "skipped", reason: initialFailure };
      else entry = await withChapterDownloadDeletion([chapterId], async () => {
        discardQueuedChapterDownloads([chapterId]);
        await cancelChapterDownloadTasks([chapterId]);
        await waitForChapterDownloadQueueMutations();
        if (isTauriRuntime()) await invoke("chapter_download_queue_remove", { chapterIds: [chapterId] });
        await waitForChapterDownloadWrites([chapterId]);
        signal?.throwIfAborted();
        return runWorkContentStorageOperation(candidate.identity.novel.pluginId, candidate.novelPath, async (): Promise<ChapterCleanupTargetResult> => {
          const initialFailure = await eligibilityFailure(preview, target);
          if (initialFailure) return { chapterId, status: "skipped", reason: initialFailure };
          const local = await inspectChapterPayloadInventory(candidate.identity, signal);
          if (local.fingerprint !== target.snapshot.fingerprint || (candidate.localServerFingerprint && candidate.localServerFingerprint !== local.fingerprint)) return { chapterId, status: "skipped", reason: "changed" };
          let server = target.server;
          if (preview.filters.server !== "any") {
            try {
              const serverUrl = cleanupServerUrl(candidate, preview.serverSetting);
              if (!server || serverUrl !== server.serverUrl) return { chapterId, status: "skipped", reason: "changed" };
              const current = await fetchCleanupServerInventory(candidate, serverUrl, signal, preview.filters.server === "server-present");
              if (current.id !== server.id || current.revision !== server.revision) return { chapterId, status: "skipped", reason: "changed" };
              server = current;
            } catch (error) { signal?.throwIfAborted(); return { chapterId, status: "skipped", reason: cleanupServerFailure(error) }; }
          }
          const reason = chapterCleanupInventorySkip(preview.filters.server, local, server);
          if (reason) return { chapterId, status: "skipped", reason };
          signal?.throwIfAborted();
          const finalFailure = await eligibilityFailure(preview, target);
          if (finalFailure) return { chapterId, status: "skipped", reason: finalFailure };
          mutationStarted = true;
          let deletionErrors: string[] = [];
          try {
            const deletion = await deleteChapterPayload(candidate.identity, target.snapshot.fingerprint);
            deletionErrors = deletion.errors.map(error => error.message);
            // Reconcile completed native work even if cancellation arrived during deletion.
            const changed = await reconcileCleanedChapter(candidate, deletion.snapshot);
            result.bytesFreed += Math.max(0, local.payloadBytes - deletion.snapshot.payloadBytes);
            if (!changed) return { chapterId, status: "failed", reason: "Chapter identity changed before download state could be updated." };
            return deletion.errors.length || deletion.snapshot.payloadBytes > 0
              ? { chapterId, status: "failed", reason: deletionErrors.join("; ") || "Some chapter payload files remain." }
              : { chapterId, status: "deleted" };
          } catch (error) {
            let recoveryError: unknown;
            try {
              const remaining = await inspectChapterPayloadInventory(candidate.identity);
              result.bytesFreed += Math.max(0, local.payloadBytes - remaining.payloadBytes);
              if (!await reconcileCleanedChapter(candidate, remaining)) throw new Error("Chapter identity changed before download state could be updated.");
            } catch (recovery) { recoveryError = recovery; }
            const reasons = [...deletionErrors, String(error)];
            if (recoveryError) reasons.push("reconciliation failed: " + String(recoveryError));
            return { chapterId, status: "failed", reason: reasons.join("; ") };
          }
        });
      });
    } catch (error) {
      if (signal?.aborted && !mutationStarted) break;
      entry = { chapterId, status: "failed", reason: String(error) };
    }
    result[entry.status]++;
    result.results.push(entry);
    if (Date.now() - lastProgress >= 100) { onProgress?.({ ...result, results: [...result.results] }); lastProgress = Date.now(); }
  }
  result.cancelled = result.total - result.results.length;
  onProgress?.({ ...result, results: [...result.results] });
  return result;
}

/**
 * Lightweight 1-pass executor for automatic finished-chapter cleanup.
 * Trusts server `complete: true` metadata via `/catalog/chapter` (plus a pre-delete
 * `id`/`revision` recheck and `replace-server` pending-upload deferral) instead of
 * running forensic SHA-256 hashing or `/storage-inventory`.
 */
export async function runFinishedChapterCleanupTask(
  filters: ChapterCleanupFilters,
  serverSetting: string,
  candidates: readonly ChapterCleanupCandidate[],
  options: ChapterCleanupRunOptions = {},
): Promise<ChapterCleanupResult> {
  const { signal, onProgress } = options;
  const result: ChapterCleanupResult = {
    total: candidates.length,
    deleted: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    bytesFreed: 0,
    results: [],
  };
  let lastProgress = 0;

  for (const candidate of candidates) {
    if (signal?.aborted) break;
    const chapterId = candidate.identity.chapter.id;
    const chapterRef = {
      pluginId: candidate.identity.novel.pluginId,
      novelPath: candidate.novelPath,
      chapterPath: candidate.chapterPath,
    };
    let entry: ChapterCleanupTargetResult;
    let mutationStarted = false;

    try {
      if (candidate.storageAmbiguous) {
        entry = { chapterId, status: "skipped", reason: "ambiguous-storage" };
      } else {
        const initialFailure = await finishedEligibilityFailure(filters, serverSetting, candidate);
        if (initialFailure) {
          entry = { chapterId, status: "skipped", reason: initialFailure };
        } else {
          let initialServer: ServerCompleteChapter | null = null;
          let resolvedServerUrl = "";
          let preLockSkip: string | null = null;

          if (filters.server !== "any") {
            try {
              resolvedServerUrl = cleanupServerUrl(candidate, serverSetting);
              if (!resolvedServerUrl) {
                preLockSkip = "no-server";
              } else if (await hasPendingReplaceServerUpload(resolvedServerUrl, chapterRef)) {
                preLockSkip = "pending-upload";
              } else {
                const verified = await verifyServerCompleteChapter(candidate, resolvedServerUrl, signal);
                if (!verified.ok) {
                  preLockSkip = verified.reason;
                } else {
                  initialServer = verified.chapter;
                }
              }
            } catch (error) {
              signal?.throwIfAborted();
              preLockSkip = cleanupServerFailure(error);
            }
          }

          if (preLockSkip) {
            entry = { chapterId, status: "skipped", reason: preLockSkip };
          } else {
            entry = await withChapterDownloadDeletion([chapterId], async () => {
              discardQueuedChapterDownloads([chapterId]);
              await cancelChapterDownloadTasks([chapterId]);
              await waitForChapterDownloadQueueMutations();
              if (isTauriRuntime()) {
                await invoke("chapter_download_queue_remove", { chapterIds: [chapterId] });
              }
              await waitForChapterDownloadWrites([chapterId]);
              signal?.throwIfAborted();
              return runWorkContentStorageOperation(
                candidate.identity.novel.pluginId,
                candidate.novelPath,
                async (): Promise<ChapterCleanupTargetResult> => {
                  const lockedFailure = await finishedEligibilityFailure(filters, serverSetting, candidate);
                  if (lockedFailure) return { chapterId, status: "skipped", reason: lockedFailure };

                  if (filters.server !== "any") {
                    try {
                      const currentUrl = cleanupServerUrl(candidate, serverSetting);
                      if (!initialServer || !currentUrl || currentUrl !== initialServer.serverUrl) {
                        return { chapterId, status: "skipped", reason: "changed" };
                      }
                      if (await hasPendingReplaceServerUpload(currentUrl, chapterRef)) {
                        return { chapterId, status: "skipped", reason: "pending-upload" };
                      }
                      const current = await verifyServerCompleteChapter(candidate, currentUrl, signal);
                      if (!current.ok) {
                        return { chapterId, status: "skipped", reason: current.reason };
                      }
                      if (
                        current.chapter.id !== initialServer.id ||
                        current.chapter.revision !== initialServer.revision
                      ) {
                        return { chapterId, status: "skipped", reason: "changed" };
                      }
                    } catch (error) {
                      signal?.throwIfAborted();
                      return { chapterId, status: "skipped", reason: cleanupServerFailure(error) };
                    }
                  }

                  signal?.throwIfAborted();
                  mutationStarted = true;
                  let deletionErrors: string[] = [];
                  try {
                    const deletion = await deleteChapterPayloadFast(candidate.identity, signal);
                    deletionErrors = deletion.errors.map((error) => error.message);
                    // Reconcile completed native work even if cancellation arrived during deletion.
                    const changed = await reconcileCleanedChapter(candidate, deletion.snapshot);
                    result.bytesFreed += deletion.bytesFreed;
                    if (!changed) {
                      return {
                        chapterId,
                        status: "failed",
                        reason: "Chapter identity changed before download state could be updated.",
                      };
                    }
                    return deletion.errors.length || deletion.snapshot.payloadBytes > 0
                      ? {
                          chapterId,
                          status: "failed",
                          reason: deletionErrors.join("; ") || "Some chapter payload files remain.",
                        }
                      : { chapterId, status: "deleted" };
                  } catch (error) {
                    let recoveryError: unknown;
                    try {
                      const remaining = await inspectChapterPayloadInventory(candidate.identity);
                      if (!(await reconcileCleanedChapter(candidate, remaining))) {
                        throw new Error("Chapter identity changed before download state could be updated.");
                      }
                    } catch (recovery) {
                      recoveryError = recovery;
                    }
                    const reasons = [...deletionErrors, String(error)];
                    if (recoveryError) reasons.push("reconciliation failed: " + String(recoveryError));
                    return { chapterId, status: "failed", reason: reasons.join("; ") };
                  }
                },
              );
            });
          }
        }
      }
    } catch (error) {
      if (signal?.aborted && !mutationStarted) break;
      entry = { chapterId, status: "failed", reason: String(error) };
    }

    result[entry.status]++;
    result.results.push(entry);
    if (Date.now() - lastProgress >= 100) {
      onProgress?.({ ...result, results: [...result.results] });
      lastProgress = Date.now();
    }
  }

  result.cancelled = result.total - result.results.length;
  onProgress?.({ ...result, results: [...result.results] });
  return result;
}

/** True while a cleanup run is queued or running, so another one waits for the next chance. */
export function isChapterCleanupActive(): boolean {
  return taskScheduler.getSnapshot().records.some((task) => task.kind === "maintenance.clearDownloadedContent" &&
    (task.status === "queued" || task.status === "running"));
}

export function enqueueFinishedChapterCleanup(
  filters: ChapterCleanupFilters,
  serverSetting: string,
  candidates: readonly ChapterCleanupCandidate[],
  title: string,
  onProgress?: ChapterCleanupRunOptions["onProgress"],
  priority: TaskPriority = "background",
): TaskHandle<ChapterCleanupResult> {
  let execution: Promise<ChapterCleanupResult> | undefined;
  const handle = taskScheduler.enqueueMain({
    kind: "maintenance.clearDownloadedContent",
    title,
    priority,
    exclusive: false,
    canRetry: false,
    canCancel: true,
    dedupeKey: "device-chapter-cleanup",
    run: (context) =>
      (execution = runFinishedChapterCleanupTask(filters, serverSetting, candidates, {
        signal: context.signal,
        onProgress: (result) => {
          context.setProgress({
            current: result.deleted + result.skipped + result.failed,
            total: result.total,
          });
          onProgress?.(result);
        },
      })),
  });
  return {
    id: handle.id,
    promise: handle.promise.catch((error) => {
      if (execution) return execution;
      if (!isTaskUserCancelledError(error)) throw error;
      const cancelled: ChapterCleanupResult = {
        total: candidates.length,
        deleted: 0,
        skipped: 0,
        failed: 0,
        cancelled: candidates.length,
        bytesFreed: 0,
        results: [],
      };
      onProgress?.(cancelled);
      return cancelled;
    }),
  };
}

export function enqueueChapterCleanup(
  preview: ChapterCleanupPreview,
  title: string,
  onProgress?: ChapterCleanupRunOptions["onProgress"],
  priority: TaskPriority = "user",
): TaskHandle<ChapterCleanupResult> {
  let execution: Promise<ChapterCleanupResult> | undefined;
  const handle = taskScheduler.enqueueMain({
    kind: "maintenance.clearDownloadedContent", title, priority, exclusive: false, canRetry: false,
    canCancel: true, dedupeKey: "device-chapter-cleanup",
    run: context => execution = runChapterCleanup(preview, { signal: context.signal, onProgress: result => {
      context.setProgress({ current: result.deleted + result.skipped + result.failed, total: result.total });
      onProgress?.(result);
    } }),
  });
  return { id: handle.id, promise: handle.promise.catch(error => {
    if (execution) return execution;
    if (!isTaskUserCancelledError(error)) throw error;
    const cancelled: ChapterCleanupResult = { total: preview.targets.length, deleted: 0, skipped: 0, failed: 0,
      cancelled: preview.targets.length, bytesFreed: 0, results: [] };
    onProgress?.(cancelled);
    return cancelled;
  }) };
}
