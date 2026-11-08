import type { QueryInvalidator } from "../reader-query-invalidation";
import {
  setUserStateActiveServer, subscribeUserStateApplied, subscribeUserStateChanges,
} from "../../db/user-state";
import { useContentSyncStore } from "../../store/content-sync";
import { useReaderStore } from "../../store/reader";
import { useUserStateStore } from "../../store/user-state";
import { isAbortError, requestAbortedError } from "../abort";
import { synchronizeUserState } from "./sync";

/** Receive only from the configured content server; this scheduler never fetches provider pages. */
export function startUserStateScheduler(queryClient?: QueryInvalidator): () => void {
  let disposed = false;
  let generation = 0;
  let syncing = false;
  let pending = false;
  let failures = 0;
  let retryNotBefore = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let invalidateTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  function active(): boolean {
    const serverUrl = useContentSyncStore.getState().serverUrl;
    return !disposed && !!serverUrl && useUserStateStore.getState().enabledByServer[serverUrl] === true &&
      document.visibilityState !== "hidden" && navigator.onLine !== false;
  }
  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function schedule(delay = 1500): void {
    if (!active()) return;
    pending = true;
    clearTimer();
    if (!syncing) timer = setTimeout(() => { timer = undefined; void run(); }, Math.max(delay, retryNotBefore - Date.now()));
  }
  async function run(): Promise<void> {
    if (!active() || syncing) return;
    const current = generation;
    const nextController = new AbortController();
    controller = nextController;
    syncing = true;
    pending = false;
    let failed = false;
    try {
      await synchronizeUserState({ signal: nextController.signal });
      if (current === generation) { failures = 0; retryNotBefore = 0; }
    } catch (error) {
      // The service retains its outbox and exposes the error without generating replacement operations.
      failed = !nextController.signal.aborted && !isAbortError(error);
      if (failed && current === generation) {
        failures++;
        retryNotBefore = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(failures - 1, 5));
      }
    } finally {
      syncing = false;
      if (controller === nextController) controller = undefined;
    }
    if (!active()) return;
    if (current !== generation) schedule(0);
    else if (failed) schedule(0);
    else schedule(pending ? 1500 : 60_000);
  }
  function restart(): void {
    generation++;
    failures = 0;
    retryNotBefore = 0;
    pending = false;
    clearTimer();
    controller?.abort(requestAbortedError());
    setUserStateActiveServer(useContentSyncStore.getState().serverUrl || null);
    schedule(0);
  }

  const unsubscribeConfig = useContentSyncStore.subscribe((state, previous) => {
    if (state.serverUrl !== previous.serverUrl) restart();
  });
  const unsubscribeEnabled = useUserStateStore.subscribe((state, previous) => {
    if (state.enabledByServer !== previous.enabledByServer) restart();
  });
  const unsubscribeChanges = subscribeUserStateChanges(() => schedule());
  const unsubscribeApplied = subscribeUserStateApplied(effects => {
    for (const effect of effects.resumes) useReaderStore.getState().applySharedResume(effect);
    if (!queryClient || disposed || invalidateTimer !== undefined) return;
    invalidateTimer = setTimeout(() => {
      invalidateTimer = undefined;
      // These prefixes contain local DB views. Provider searches and download queues are not invalidated.
      for (const key of ["novel", "chapter", "category"]) {
        void queryClient.invalidateQueries({ queryKey: [key] }).catch(() => undefined);
      }
    }, 150);
  });
  window.addEventListener("online", restart);
  window.addEventListener("offline", restart);
  document.addEventListener("visibilitychange", restart);
  restart();
  return () => {
    disposed = true;
    generation++;
    clearTimer();
    if (invalidateTimer !== undefined) clearTimeout(invalidateTimer);
    controller?.abort(requestAbortedError());
    unsubscribeConfig();
    unsubscribeEnabled();
    unsubscribeChanges();
    unsubscribeApplied();
    setUserStateActiveServer(null);
    window.removeEventListener("online", restart);
    window.removeEventListener("offline", restart);
    document.removeEventListener("visibilitychange", restart);
  };
}
