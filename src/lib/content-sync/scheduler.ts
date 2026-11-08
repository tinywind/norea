import { subscribeContentSyncChanges } from "../../db/content-sync-journal";
import { listNovelMigrations } from "../../db/queries/content-sync";
import { PendingNovelMigrationError } from "./novel-migration";
import { PendingIncomingMigrationError } from "./migration-feed";
import { useContentSyncStore } from "../../store/content-sync";
import { ContentServerError, contentServerRequest } from "./client";
import { getContentSyncCursors, syncContentServer, syncReceivedWorkMigrations } from "./sync";
import { subscribeWorkMetadataChanges } from "../work-metadata";
import { subscribeChapterDownloadsSettled } from "../tasks/chapter-download-activity";

export function startContentServerSync(): () => void {
  let disposed = false;
  let generation = 0;
  let syncing = false;
  let pending = false;
  let failures = 0;
  let pollFailures = 0;
  let migrationResumePending = false;
  let migrationLookupPending = false;
  let incomingError: { serverUrl: string; message: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: AbortController | undefined;

  function active(): boolean {
    const state = useContentSyncStore.getState();
    return !disposed && !!state.serverUrl
      && document.visibilityState !== "hidden" && navigator.onLine !== false;
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

  function requestSync(delay = 1500): void {
    if (!active() || migrationLookupPending) return;
    pending = true;
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
      const hint = await contentServerRequest<{ catalogCursor: number; workCursor: number }>(
        serverUrl, `/changes?catalogAfter=${cursor.catalogCursor}&workAfter=${cursor.workCursor}&waitSeconds=20`,
        deviceKey ?? undefined, "GET", undefined, controller.signal,
      );
      if (controller.signal.aborted || current !== generation || !active()) return;
      poll = undefined;
      pollFailures = 0;
      if (hint.catalogCursor !== cursor.catalogCursor || hint.workCursor !== cursor.workCursor) requestSync(0);
      else timer = setTimeout(() => { timer = undefined; void waitForChanges(); }, 250);
    } catch {
      if (controller.signal.aborted || current !== generation || !active()) return;
      poll = undefined;
      requestSync(retryDelay(pollFailures++));
    }
  }

  async function run(): Promise<void> {
    if (!active() || syncing || migrationLookupPending) return;
    const current = generation;
    const manual = useContentSyncStore.getState().syncMode === "manual";
    const resumedMigration = manual && migrationResumePending;
    const receiveOnly = manual && !resumedMigration;
    const controller = receiveOnly ? new AbortController() : undefined;
    if (controller) poll = controller;
    syncing = true;
    pending = false;
    let failed = false;
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
      }
    } catch (error) {
      if (!controller?.signal.aborted && current === generation && active()) {
        failed = !((error instanceof PendingNovelMigrationError || error instanceof PendingIncomingMigrationError) && !error.retryable);
        if (receiveOnly) reportIncomingError(error);
        if (!failed) failures = 0;
      }
    } finally {
      syncing = false;
      if (controller && poll === controller) poll = undefined;
    }
    if (!active()) return;
    if (current !== generation || pending) {
      requestSync(current !== generation ? 0 : 1500);
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
    failures = 0;
    pollFailures = 0;
    pending = false;
    cancelWait();
    if (!active()) return;
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

  const unsubscribe = useContentSyncStore.subscribe((state, previous) => {
    if (state.syncMode !== previous.syncMode || state.syncIntervalMinutes !== previous.syncIntervalMinutes
      || state.serverUrl !== previous.serverUrl) restart();
  });
  const unsubscribeChanges = subscribeContentSyncChanges(() => {
    if (useContentSyncStore.getState().syncMode === "changes") requestSync();
  });
  const unsubscribeMetadata = subscribeWorkMetadataChanges(() => {
    if (useContentSyncStore.getState().syncMode === "changes") requestSync();
  });
  const unsubscribeDownloads = subscribeChapterDownloadsSettled(() => {
    if (useContentSyncStore.getState().syncMode === "changes") requestSync();
  });
  window.addEventListener("online", restart);
  window.addEventListener("offline", restart);
  document.addEventListener("visibilitychange", restart);
  restart();
  return () => {
    disposed = true;
    generation++;
    cancelWait();
    unsubscribe();
    unsubscribeChanges();
    unsubscribeMetadata();
    unsubscribeDownloads();
    window.removeEventListener("online", restart);
    window.removeEventListener("offline", restart);
    document.removeEventListener("visibilitychange", restart);
  };
}
