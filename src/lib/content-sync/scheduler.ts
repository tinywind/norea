import { subscribeContentSyncChanges } from "../../db/content-sync-journal";
import { useContentSyncStore } from "../../store/content-sync";
import { contentServerRequest } from "./client";
import { getContentSyncCursors, syncContentServer } from "./sync";

export function startContentServerSync(): () => void {
  let disposed = false;
  let generation = 0;
  let syncing = false;
  let pending = false;
  let failures = 0;
  let pollFailures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: AbortController | undefined;

  function active(): boolean {
    const state = useContentSyncStore.getState();
    return !disposed && state.syncMode !== "manual" && !!state.serverUrl
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

  function requestSync(delay = 1500): void {
    if (!active()) return;
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
      const hint = await contentServerRequest<{ catalogCursor: number }>(
        serverUrl, `/changes?catalogAfter=${cursor.catalogCursor}&waitSeconds=20`,
        deviceKey ?? undefined, "GET", undefined, controller.signal,
      );
      if (controller.signal.aborted || current !== generation || !active()) return;
      poll = undefined;
      pollFailures = 0;
      if (hint.catalogCursor !== cursor.catalogCursor) requestSync(0);
      else timer = setTimeout(() => { timer = undefined; void waitForChanges(); }, 250);
    } catch {
      if (controller.signal.aborted || current !== generation || !active()) return;
      poll = undefined;
      requestSync(retryDelay(pollFailures++));
    }
  }

  async function run(): Promise<void> {
    if (!active() || syncing) return;
    const current = generation;
    syncing = true;
    pending = false;
    let failed = false;
    try {
      await syncContentServer();
      failures = 0;
    } catch {
      failed = true;
    } finally {
      syncing = false;
    }
    if (!active()) return;
    if (current !== generation || pending) {
      requestSync();
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
    failures = 0;
    pollFailures = 0;
    pending = false;
    cancelWait();
    if (active()) requestSync(0);
  }

  const unsubscribe = useContentSyncStore.subscribe((state, previous) => {
    if (state.syncMode !== previous.syncMode || state.syncIntervalMinutes !== previous.syncIntervalMinutes
      || state.serverUrl !== previous.serverUrl) restart();
  });
  const unsubscribeChanges = subscribeContentSyncChanges(() => {
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
    window.removeEventListener("online", restart);
    window.removeEventListener("offline", restart);
    document.removeEventListener("visibilitychange", restart);
  };
}
