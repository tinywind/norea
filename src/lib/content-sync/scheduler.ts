import { subscribeContentSyncChanges } from "../../db/content-sync-journal";
import { listNovelMigrations } from "../../db/queries/content-sync";
import { PendingNovelMigrationError } from "./novel-migration";
import { PendingIncomingMigrationError } from "./migration-feed";
import { useContentSyncStore } from "../../store/content-sync";
import { isAbortError } from "../abort";
import { isAppActive, subscribeAppLifecycle } from "../app-lifecycle";
import { ContentServerError, contentServerRequest } from "./client";
import { abortActiveContentSync, getContentSyncCursors, syncContentServer, syncReceivedWorkMigrations } from "./sync";
import { WorkMetadataChangedOutsideCacheError } from "./works";
import { subscribeWorkMetadataChanges } from "../work-metadata";
import { isHostNetworkConnected, subscribeHostNetworkConnection } from "../network";
import { subscribeChapterDownloadsSettled } from "../tasks/chapter-download-activity";
import {
  consumeDeferredContentUploadDueToDownload,
  hasDeferredContentUploadDueToDownload,
  isSyncBackgroundExecutionSuspended,
  setPendingContentSyncUpload,
  subscribeSyncBackgroundExecutionSuspended,
} from "../tasks/sync-runtime";

export function startContentServerSync(): () => void {
  let disposed = false;
  let generation = 0;
  let syncing = false;
  let pending = false;
  let pendingAllowInactive = false;
  let hasLocalUploadPending = false;
  let nonRetryableStopped = false;
  let failures = 0;
  let pollFailures = 0;
  let migrationResumePending = false;
  let migrationLookupPending = false;
  let incomingError: { serverUrl: string; message: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: AbortController | undefined;

  function configured(): boolean {
    const state = useContentSyncStore.getState();
    return !disposed && !!state.serverUrl && isHostNetworkConnected() && !isSyncBackgroundExecutionSuspended();
  }

  function isServerBlocked(): boolean {
    return useContentSyncStore.getState().blocked === true;
  }

  function active(): boolean {
    return configured() && isAppActive();
  }

  function cancelWait(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    poll?.abort();
    poll = undefined;
  }

  function retryDelay(count: number): number {
    return Math.min(60_000, 2000 * 2 ** Math.min(count, 5));
  }

  function reportIncomingError(error: unknown): void {
    const state = useContentSyncStore.getState();
    if (state.status === "syncing" || (state.error && (incomingError?.serverUrl !== state.serverUrl || incomingError.message !== state.error))) return;
    const message = error instanceof Error ? error.message : String(error);
    incomingError = { serverUrl: state.serverUrl, message };
    if (state.status !== "error" || state.error !== message) {
      useContentSyncStore.setState({ status: "error", error: message, blocked: error instanceof ContentServerError && error.status === 403 });
    }
  }

  function clearIncomingError(): void {
    const state = useContentSyncStore.getState();
    if (incomingError?.serverUrl === state.serverUrl && state.status === "error" && state.error === incomingError.message) {
      useContentSyncStore.setState({ status: "idle", error: null, blocked: false });
    }
    incomingError = undefined;
  }

  function requestSync(delay = 1500, allowInactive = false): void {
    if (!configured() || (!allowInactive && !isAppActive()) || migrationLookupPending) return;
    pending = true;
    pendingAllowInactive ||= allowInactive;
    cancelWait();
    if (!syncing) timer = setTimeout(() => { timer = undefined; void run(); }, delay);
  }

  async function waitForChanges(): Promise<void> {
    if (!active() || useContentSyncStore.getState().syncMode !== "changes" || syncing) return;
    const current = generation;
    const controller = new AbortController();
    poll = controller;
    const { serverUrl, deviceKey } = useContentSyncStore.getState();
    try {
      const cursor = await getContentSyncCursors();
      if (controller.signal.aborted || current !== generation) return;
      const overrideQuery = cursor.overrideCursor !== undefined ? `&overrideAfter=${cursor.overrideCursor}` : "";
      const hint = await contentServerRequest<{ catalogCursor: number; workCursor: number; overrideCursor?: number }>(
        serverUrl, `/changes?catalogAfter=${cursor.catalogCursor}&workAfter=${cursor.workCursor}${overrideQuery}&waitSeconds=20`,
        deviceKey ?? undefined, "GET", undefined, controller.signal,
      );
      if (controller.signal.aborted || current !== generation || !active()) return;
      poll = undefined;
      pollFailures = 0;
      if (
        hint.catalogCursor !== cursor.catalogCursor ||
        hint.workCursor !== cursor.workCursor ||
        (cursor.overrideCursor !== undefined &&
          hint.overrideCursor !== undefined &&
          hint.overrideCursor !== cursor.overrideCursor)
      ) requestSync(0);
      else timer = setTimeout(() => { timer = undefined; void waitForChanges(); }, 250);
    } catch {
      if (controller.signal.aborted || current !== generation || !active()) return;
      poll = undefined;
      requestSync(retryDelay(pollFailures++));
    }
  }

  async function run(): Promise<void> {
    const allowInactive = pendingAllowInactive;
    if (!configured() || (!allowInactive && !isAppActive()) || syncing || migrationLookupPending) return;
    const current = generation;
    const manual = useContentSyncStore.getState().syncMode === "manual";
    const resumedMigration = manual && migrationResumePending;
    const receiveOnly = manual && !resumedMigration;
    if (receiveOnly && !isAppActive()) {
      pending = false;
      pendingAllowInactive = false;
      return;
    }
    const controller = receiveOnly ? new AbortController() : undefined;
    if (controller) poll = controller;
    syncing = true;
    pending = false;
    pendingAllowInactive = false;
    if (!receiveOnly) {
      hasLocalUploadPending = false;
      // Raise pendingContentUpload before clearing the deferred flag so Android's native hint never dips to false.
      setPendingContentSyncUpload(true);
      consumeDeferredContentUploadDueToDownload();
    }
    let failed = false;
    let stopAutoRetries = false;
    try {
      if (receiveOnly) {
        const result = await syncReceivedWorkMigrations(controller!.signal);
        if (!controller!.signal.aborted && current === generation && active()) {
          if (result.pending) {
            reportIncomingError(new PendingIncomingMigrationError(result.pending, result.error, result.retryable));
            failed = result.retryable === true;
          } else clearIncomingError();
          if (!failed) failures = 0;
        }
      } else {
        await syncContentServer(true, false, false);
        failures = 0;
        nonRetryableStopped = false;
      }
    } catch (error) {
      if (!controller?.signal.aborted && !isAbortError(error) && current === generation && configured()) {
        const nonRetryableMigration =
          (error instanceof PendingNovelMigrationError || error instanceof PendingIncomingMigrationError) && !error.retryable;
        const blockedOrOutsideCache =
          (error instanceof ContentServerError && error.status === 403) ||
          error instanceof WorkMetadataChangedOutsideCacheError;
        stopAutoRetries = blockedOrOutsideCache;
        if (blockedOrOutsideCache) {
          nonRetryableStopped = true;
          hasLocalUploadPending = false;
          consumeDeferredContentUploadDueToDownload();
        }
        failed = !nonRetryableMigration && !blockedOrOutsideCache;
        if (receiveOnly && isAppActive()) reportIncomingError(error);
        if (!failed) failures = 0;
      }
    } finally {
      syncing = false;
      if (controller && poll === controller) poll = undefined;
      if (!receiveOnly && (!hasLocalUploadPending || nonRetryableStopped || isServerBlocked())) {
        setPendingContentSyncUpload(false);
      }
    }
    if (!configured()) return;
    if (!isAppActive()) {
      // Never poll or schedule retry loops while inactive; finish only newly queued local uploads.
      if (
        !failed &&
        !stopAutoRetries &&
        !nonRetryableStopped &&
        !isServerBlocked() &&
        pending &&
        hasLocalUploadPending &&
        useContentSyncStore.getState().syncMode === "changes"
      ) {
        requestSync(0, true);
      } else {
        pending = false;
        pendingAllowInactive = false;
        setPendingContentSyncUpload(false);
      }
      return;
    }
    if (current !== generation) {
      requestSync(0);
    } else if (stopAutoRetries || nonRetryableStopped) {
      pending = false;
      pendingAllowInactive = false;
      hasLocalUploadPending = false;
      setPendingContentSyncUpload(false);
      return;
    } else if (pending) {
      requestSync(1500);
    } else if (resumedMigration) {
      // An approved outgoing operation runs once; manual clients then receive only migration events.
      migrationResumePending = false;
      requestSync(0);
    } else if (receiveOnly) {
      requestSync(failed ? retryDelay(failures++) : 30_000);
    } else if (useContentSyncStore.getState().syncMode === "periodic") {
      requestSync(useContentSyncStore.getState().syncIntervalMinutes * 60_000);
    } else if (failed) {
      requestSync(retryDelay(failures++));
    } else {
      void waitForChanges();
    }
  }

  function restart(): void {
    generation++;
    migrationResumePending = false;
    migrationLookupPending = false;
    nonRetryableStopped = false;
    failures = 0;
    pollFailures = 0;
    pending = false;
    pendingAllowInactive = false;
    cancelWait();
    if (!active()) {
      if (!configured() || useContentSyncStore.getState().syncMode !== "changes") {
        hasLocalUploadPending = false;
        setPendingContentSyncUpload(false);
      }
      return;
    }
    if (useContentSyncStore.getState().syncMode !== "manual") {
      requestSync(0);
      return;
    }
    const current = generation;
    const { serverUrl } = useContentSyncStore.getState();
    migrationLookupPending = true;
    // Discover previously approved outgoing work before starting the receive-only loop.
    void listNovelMigrations(serverUrl).then(jobs => {
      if (disposed || current !== generation || !active()) return;
      migrationLookupPending = false;
      migrationResumePending = jobs.some(job => job.status === "pending" || job.status === "failed");
      requestSync(0);
    }).catch(error => {
      if (disposed || current !== generation || !active()) return;
      migrationLookupPending = false;
      reportIncomingError(error);
      requestSync(0);
    });
  }

  function onAppLifecycleChange(appActive: boolean): void {
    if (appActive) {
      restart();
      return;
    }
    // Cancel active-only waiting/polling immediately, while keeping any in-flight upload running.
    cancelWait();
    if (migrationLookupPending) {
      generation++;
      migrationLookupPending = false;
    }
    if (nonRetryableStopped || isServerBlocked()) {
      hasLocalUploadPending = false;
      pending = false;
      pendingAllowInactive = false;
      consumeDeferredContentUploadDueToDownload();
      setPendingContentSyncUpload(false);
      return;
    }
    if (
      !syncing &&
      configured() &&
      useContentSyncStore.getState().syncMode === "changes" &&
      (hasLocalUploadPending || hasDeferredContentUploadDueToDownload())
    ) {
      setPendingContentSyncUpload(true);
      requestSync(0, true);
    } else if (!syncing) {
      pending = false;
      pendingAllowInactive = false;
      setPendingContentSyncUpload(false);
    }
  }

  function onLocalUploadChange(): void {
    if (useContentSyncStore.getState().syncMode !== "changes") return;
    if (!configured() || nonRetryableStopped || isServerBlocked()) return;
    hasLocalUploadPending = true;
    setPendingContentSyncUpload(true);
    requestSync(1500, !isAppActive());
  }

  const unsubscribe = useContentSyncStore.subscribe((state, previous) => {
    if (state.syncMode !== previous.syncMode || state.syncIntervalMinutes !== previous.syncIntervalMinutes
      || state.serverUrl !== previous.serverUrl) {
      if (state.serverUrl !== previous.serverUrl) abortActiveContentSync?.();
      restart();
      return;
    }
    if (state.blocked && !previous.blocked) {
      nonRetryableStopped = true;
      hasLocalUploadPending = false;
      consumeDeferredContentUploadDueToDownload();
      if (!syncing) {
        pending = false;
        pendingAllowInactive = false;
        cancelWait();
        setPendingContentSyncUpload(false);
      }
      return;
    }
    if (
      nonRetryableStopped &&
      !syncing &&
      previous.status === "syncing" &&
      state.status === "idle" &&
      !state.error &&
      !state.blocked
    ) {
      nonRetryableStopped = false;
      failures = 0;
      pollFailures = 0;
      if (active()) {
        if (state.syncMode === "changes") void waitForChanges();
        else if (state.syncMode === "periodic") requestSync(state.syncIntervalMinutes * 60_000);
      }
    }
  });
  const unsubscribeChanges = subscribeContentSyncChanges(onLocalUploadChange);
  const unsubscribeMetadata = subscribeWorkMetadataChanges(onLocalUploadChange);
  const unsubscribeDownloads = subscribeChapterDownloadsSettled(() => {
    if (
      useContentSyncStore.getState().syncMode !== "changes" ||
      !configured() ||
      nonRetryableStopped ||
      isServerBlocked()
    ) {
      return;
    }
    if (isAppActive()) {
      requestSync();
    } else if (hasLocalUploadPending || hasDeferredContentUploadDueToDownload()) {
      hasLocalUploadPending = true;
      setPendingContentSyncUpload(true);
      consumeDeferredContentUploadDueToDownload();
      requestSync(0, true);
    }
  });
  const unsubscribeNetwork = subscribeHostNetworkConnection((connected) => {
    if (!connected) {
      abortActiveContentSync?.();
      restart();
    } else if (isAppActive()) {
      restart();
    }
  });
  const unsubscribeSuspended = subscribeSyncBackgroundExecutionSuspended((suspended) => {
    if (suspended) {
      abortActiveContentSync?.();
      cancelWait();
      pending = false;
      pendingAllowInactive = false;
      setPendingContentSyncUpload(false);
    } else if (isAppActive()) {
      restart();
    }
  });
  const unsubscribeLifecycle = subscribeAppLifecycle(onAppLifecycleChange);
  restart();
  return () => {
    disposed = true;
    generation++;
    cancelWait();
    setPendingContentSyncUpload(false);
    unsubscribe();
    unsubscribeChanges();
    unsubscribeMetadata();
    unsubscribeDownloads();
    unsubscribeNetwork();
    unsubscribeSuspended();
    unsubscribeLifecycle();
  };
}
