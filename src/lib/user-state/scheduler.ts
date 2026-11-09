import type { QueryInvalidator } from "../reader-query-invalidation";
import {
  setUserStateActiveServer, subscribeUserStateApplied, subscribeUserStateChanges,
  type UserStateChangePriority,
} from "../../db/user-state";
import { useContentSyncStore } from "../../store/content-sync";
import { useReaderStore } from "../../store/reader";
import { useUserStateStore } from "../../store/user-state";
import { isAbortError, requestAbortedError } from "../abort";
import { subscribeUserStateFlush } from "./events";
import { synchronizeUserState } from "./sync";

export const USER_STATE_COMMAND_DEBOUNCE_MS = 1_500;
export const USER_STATE_READING_DEBOUNCE_MS = 20_000;
export const USER_STATE_POLL_MS = 60_000;

type RequestKind = "immediate" | "normal" | "reading" | "poll";
const requestRank: Record<RequestKind, number> = { immediate: 0, normal: 1, reading: 2, poll: 3 };
const requestDelay: Record<RequestKind, number> = {
  immediate: 0,
  normal: USER_STATE_COMMAND_DEBOUNCE_MS,
  reading: USER_STATE_READING_DEBOUNCE_MS,
  poll: USER_STATE_POLL_MS,
};

/** Receive only from the configured content server; this scheduler never fetches provider pages. */
export function startUserStateScheduler(queryClient?: QueryInvalidator): () => void {
  let disposed = false;
  let generation = 0;
  let syncing = false;
  let failures = 0;
  let retryNotBefore = 0;
  let pendingKind: RequestKind | null = null;
  let pendingDue = 0;
  let pendingAllowHidden = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let invalidateTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  function configured(): boolean {
    const serverUrl = useContentSyncStore.getState().serverUrl;
    return !disposed && !!serverUrl && useUserStateStore.getState().enabledByServer[serverUrl] === true &&
      navigator.onLine !== false;
  }
  function runnable(allowHidden: boolean): boolean {
    return configured() && (allowHidden || document.visibilityState !== "hidden");
  }
  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function arm(): void {
    clearTimer();
    if (syncing || pendingKind === null || !runnable(pendingAllowHidden)) return;
    const delay = Math.max(0, pendingDue - Date.now(), retryNotBefore - Date.now());
    timer = setTimeout(() => { timer = undefined; void run(); }, delay);
  }
  function request(kind: RequestKind, allowHidden = false): void {
    if (!configured()) return;
    const due = Date.now() + requestDelay[kind];
    if (pendingKind === null) {
      pendingKind = kind;
      pendingDue = due;
      pendingAllowHidden = allowHidden;
    } else if (requestRank[kind] < requestRank[pendingKind]) {
      const previousKind = pendingKind;
      const previousDue = pendingDue;
      pendingKind = kind;
      // A local edit must not postpone a poll that was already due sooner.
      pendingDue = previousKind === "poll" ? Math.min(previousDue, due) : due;
      pendingAllowHidden ||= allowHidden;
    } else if (requestRank[kind] === requestRank[pendingKind]) {
      // Local edits debounce from the latest commit. Polls and immediate requests never drift later.
      pendingDue = kind === "normal" || kind === "reading" ? due : Math.min(pendingDue, due);
      pendingAllowHidden ||= allowHidden;
    } else {
      pendingAllowHidden ||= allowHidden;
    }
    arm();
  }
  async function run(): Promise<void> {
    if (syncing || pendingKind === null || !runnable(pendingAllowHidden)) return;
    const current = generation;
    const allowHidden = pendingAllowHidden;
    pendingKind = null;
    pendingDue = 0;
    pendingAllowHidden = false;
    const nextController = new AbortController();
    controller = nextController;
    syncing = true;
    let failed = false;
    try {
      await synchronizeUserState({ signal: nextController.signal });
      if (current === generation) { failures = 0; retryNotBefore = 0; }
    } catch (error) {
      // The durable outbox is unchanged on failure; retries reuse the same operation receipts.
      failed = !nextController.signal.aborted && !isAbortError(error);
      if (failed && current === generation) {
        failures++;
        retryNotBefore = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(failures - 1, 5));
      }
    } finally {
      syncing = false;
      if (controller === nextController) controller = undefined;
    }
    if (disposed) return;
    if (current !== generation) { arm(); return; }
    if (failed) { request("immediate", allowHidden); return; }
    if (pendingKind !== null) { arm(); return; }
    if (document.visibilityState !== "hidden") request("poll");
  }
  function restart(allowHidden = false): void {
    generation++;
    failures = 0;
    retryNotBefore = 0;
    pendingKind = null;
    pendingDue = 0;
    pendingAllowHidden = false;
    clearTimer();
    controller?.abort(requestAbortedError());
    setUserStateActiveServer(useContentSyncStore.getState().serverUrl || null);
    if (configured() && (allowHidden || document.visibilityState !== "hidden")) request("immediate", allowHidden);
  }
  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      // Flush once before the platform suspends background timers. A reading write
      // that commits slightly later requests another hidden-safe immediate pass.
      request("immediate", true);
    } else {
      request("immediate");
    }
  }
  function onOnline(): void { restart(document.visibilityState === "hidden"); }
  function onOffline(): void { restart(false); }
  function onLocalChange(priority: UserStateChangePriority): void {
    if (document.visibilityState === "hidden") request("immediate", true);
    else request(priority === "reading" ? "reading" : "normal");
  }

  const unsubscribeConfig = useContentSyncStore.subscribe((state, previous) => {
    if (state.serverUrl !== previous.serverUrl) restart();
  });
  const unsubscribeEnabled = useUserStateStore.subscribe((state, previous) => {
    if (state.enabledByServer !== previous.enabledByServer) restart();
  });
  const unsubscribeChanges = subscribeUserStateChanges(onLocalChange);
  const unsubscribeFlush = subscribeUserStateFlush(() => request("immediate", document.visibilityState === "hidden"));
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
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  document.addEventListener("visibilitychange", onVisibilityChange);
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
    unsubscribeFlush();
    unsubscribeApplied();
    setUserStateActiveServer(null);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
