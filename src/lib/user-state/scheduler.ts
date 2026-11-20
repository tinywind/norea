import type { QueryInvalidator } from "../reader-query-invalidation";
import {
  setUserStateActiveServer, subscribeUserStateApplied, subscribeUserStateChanges,
  type UserStateChangePriority,
} from "../../db/user-state";
import { useContentSyncStore } from "../../store/content-sync";
import { useReaderStore } from "../../store/reader";
import { useUserStateStore } from "../../store/user-state";
import { isAbortError, requestAbortedError } from "../abort";
import { isAppActive, runBeforeAppSuspend, subscribeAppLifecycle } from "../app-lifecycle";
import { ContentServerError } from "../content-sync/client";
import { isHostNetworkConnected, subscribeHostNetworkConnection } from "../network";
import {
  beginSuspendingSyncFlush,
  isSyncBackgroundExecutionSuspended,
  setPendingUserStateUpload,
  subscribeSyncBackgroundExecutionSuspended,
} from "../tasks/sync-runtime";
import { subscribeUserStateFlush } from "./events";
import { hasSendableUserStateChanges, synchronizeUserState } from "./sync";
import { UserStateProtocolError } from "./types";

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

function isNonRetryableUserStateError(error: unknown): boolean {
  if (error instanceof ContentServerError && error.status === 403) return true;
  if (error instanceof UserStateProtocolError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /does not support shared user changes/i.test(message) ||
    /paused after backup restore|restore.*paused|reconnect.*shared state/i.test(message)
  );
}

/** Receive only from the configured content server; this scheduler never fetches provider pages. */
export function startUserStateScheduler(queryClient?: QueryInvalidator): () => void {
  let disposed = false;
  let generation = 0;
  let syncing = false;
  let failures = 0;
  let nonRetryableStopped = false;
  let retryNotBefore = 0;
  let hasLocalEditPending = false;
  let pendingKind: RequestKind | null = null;
  let pendingDue = 0;
  let pendingAllowHidden = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let invalidateTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  function configured(): boolean {
    const serverUrl = useContentSyncStore.getState().serverUrl;
    const state = useUserStateStore.getState();
    return !disposed && !!serverUrl && state.enabledByServer[serverUrl] === true &&
      !state.runtimeByServer[serverUrl]?.epochMismatch &&
      !isSyncBackgroundExecutionSuspended() &&
      isHostNetworkConnected();
  }
  function isServerBlocked(): boolean {
    const serverUrl = useContentSyncStore.getState().serverUrl;
    return Boolean(serverUrl && useUserStateStore.getState().runtimeByServer[serverUrl]?.blocked);
  }
  function runnable(allowHidden: boolean): boolean {
    return configured() && (allowHidden || isAppActive());
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
    pendingKind = null;
    pendingDue = 0;
    pendingAllowHidden = false;
    hasLocalEditPending = false;
    // Keep the native pending-upload hint active across synchronizeUserState()'s async handoff
    // until beginUserStateSyncRun() takes over the foreground service anchor.
    setPendingUserStateUpload(true);
    const nextController = new AbortController();
    controller = nextController;
    syncing = true;
    let failed = false;
    let nonRetryable = false;
    try {
      await synchronizeUserState({ signal: nextController.signal });
      if (current === generation) {
        failures = 0;
        nonRetryableStopped = false;
        retryNotBefore = 0;
      }
    } catch (error) {
      // The durable outbox is unchanged on failure; retries reuse the same operation receipts.
      const aborted = nextController.signal.aborted || isAbortError(error);
      nonRetryable = !aborted && isNonRetryableUserStateError(error);
      failed = !aborted && !nonRetryable;
      if (current === generation) {
        if (nonRetryable) {
          nonRetryableStopped = true;
        } else if (failed) {
          failures++;
          retryNotBefore = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(failures - 1, 5));
        }
      }
    } finally {
      syncing = false;
      if (controller === nextController) controller = undefined;
      if (!hasLocalEditPending || nonRetryableStopped || isServerBlocked()) {
        setPendingUserStateUpload(false);
      }
    }
    if (disposed) return;
    if (current !== generation) { arm(); return; }
    if (!isAppActive()) {
      // Never run background retry loops or periodic polling while inactive so the device can sleep.
      if (!failed && !nonRetryable && pendingKind !== null && pendingAllowHidden) {
        arm();
      } else {
        pendingKind = null;
        pendingDue = 0;
        pendingAllowHidden = false;
        clearTimer();
        setPendingUserStateUpload(false);
      }
      return;
    }
    if (failed) { request("immediate", false); return; }
    if (nonRetryable) {
      pendingKind = null;
      pendingDue = 0;
      pendingAllowHidden = false;
      hasLocalEditPending = false;
      clearTimer();
      setPendingUserStateUpload(false);
      return;
    }
    if (pendingKind !== null) { arm(); return; }
    request("poll");
  }
  function restart(allowHidden = false): void {
    generation++;
    failures = 0;
    nonRetryableStopped = false;
    retryNotBefore = 0;
    pendingKind = null;
    pendingDue = 0;
    pendingAllowHidden = false;
    clearTimer();
    controller?.abort(requestAbortedError());
    setUserStateActiveServer(useContentSyncStore.getState().serverUrl || null);
    if (!configured()) {
      hasLocalEditPending = false;
      setPendingUserStateUpload(false);
      return;
    }
    if (allowHidden || isAppActive()) request("immediate", allowHidden);
  }
  async function flushBeforeSuspend(): Promise<void> {
    if (!configured() || nonRetryableStopped || isServerBlocked()) {
      hasLocalEditPending = false;
      pendingKind = null;
      pendingDue = 0;
      pendingAllowHidden = false;
      clearTimer();
      setPendingUserStateUpload(false);
      return;
    }
    const endFlush = beginSuspendingSyncFlush();
    const suspendGeneration = generation;
    try {
      await runBeforeAppSuspend();
      if (
        disposed ||
        suspendGeneration !== generation ||
        isAppActive() ||
        !configured() ||
        nonRetryableStopped ||
        isServerBlocked()
      ) {
        if (!syncing && (nonRetryableStopped || isServerBlocked())) {
          hasLocalEditPending = false;
          setPendingUserStateUpload(false);
        }
        return;
      }
      const serverUrl = useContentSyncStore.getState().serverUrl;
      let shouldFlush = hasLocalEditPending;
      if (!shouldFlush && failures === 0 && typeof hasSendableUserStateChanges === "function") {
        try {
          shouldFlush = await hasSendableUserStateChanges(serverUrl);
        } catch {
          shouldFlush = false;
        }
      }
      if (
        disposed ||
        suspendGeneration !== generation ||
        isAppActive() ||
        !configured() ||
        nonRetryableStopped ||
        isServerBlocked()
      ) {
        if (!syncing && (nonRetryableStopped || isServerBlocked())) {
          hasLocalEditPending = false;
          setPendingUserStateUpload(false);
        }
        return;
      }
      if (shouldFlush) {
        retryNotBefore = 0;
        setPendingUserStateUpload(true);
        request("immediate", true);
      } else if (!syncing) {
        pendingKind = null;
        pendingDue = 0;
        pendingAllowHidden = false;
        clearTimer();
        setPendingUserStateUpload(false);
      }
    } finally {
      endFlush();
    }
  }
  function onAppLifecycleChange(appActive: boolean): void {
    if (appActive) {
      failures = 0;
      nonRetryableStopped = false;
      retryNotBefore = 0;
      request("immediate");
      return;
    }
    // Cancel foreground-only poll/retry timers immediately; flush only if sendable uploads exist.
    if (!pendingAllowHidden) {
      clearTimer();
      if (pendingKind === "poll") {
        pendingKind = null;
        pendingDue = 0;
      }
    }
    void flushBeforeSuspend();
  }
  function onOnline(): void {
    if (isAppActive()) restart(false);
  }
  function onOffline(): void { restart(false); }
  function onLocalChange(priority: UserStateChangePriority): void {
    if (!configured() || nonRetryableStopped || isServerBlocked()) return;
    hasLocalEditPending = true;
    setPendingUserStateUpload(true);
    if (!isAppActive()) request("immediate", true);
    else request(priority === "reading" ? "reading" : "normal");
  }

  const unsubscribeConfig = useContentSyncStore.subscribe((state, previous) => {
    if (state.serverUrl !== previous.serverUrl) restart();
  });
  const unsubscribeEnabled = useUserStateStore.subscribe((state, previous) => {
    const serverUrl = useContentSyncStore.getState().serverUrl;
    const prevRuntime = serverUrl ? previous.runtimeByServer[serverUrl] : undefined;
    const nextRuntime = serverUrl ? state.runtimeByServer[serverUrl] : undefined;
    const hadMismatch = Boolean(prevRuntime?.epochMismatch);
    const hasMismatch = Boolean(nextRuntime?.epochMismatch);
    if (state.enabledByServer !== previous.enabledByServer || (hadMismatch && !hasMismatch)) {
      restart();
      return;
    }
    if (!serverUrl || prevRuntime === nextRuntime) return;
    if (nextRuntime?.blocked) {
      nonRetryableStopped = true;
      hasLocalEditPending = false;
      if (!syncing) {
        pendingKind = null;
        pendingDue = 0;
        pendingAllowHidden = false;
        clearTimer();
        setPendingUserStateUpload(false);
      }
      return;
    }
    if (
      nonRetryableStopped &&
      !syncing &&
      prevRuntime?.phase === "syncing" &&
      nextRuntime?.phase === "idle" &&
      !nextRuntime.error &&
      !nextRuntime.blocked &&
      !hasMismatch
    ) {
      nonRetryableStopped = false;
      failures = 0;
      retryNotBefore = 0;
      if (isAppActive() && configured() && pendingKind === null) {
        request("poll");
      }
    }
  });
  const unsubscribeChanges = subscribeUserStateChanges(onLocalChange);
  const unsubscribeFlush = subscribeUserStateFlush(() => {
    if (!configured() || nonRetryableStopped || isServerBlocked()) return;
    hasLocalEditPending = true;
    setPendingUserStateUpload(true);
    request("immediate", !isAppActive());
  });
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
  const unsubscribeNetwork = subscribeHostNetworkConnection((connected) => {
    if (connected) onOnline();
    else onOffline();
  });
  const unsubscribeSuspended = subscribeSyncBackgroundExecutionSuspended((suspended) => {
    if (suspended) {
      generation++;
      clearTimer();
      pendingKind = null;
      pendingDue = 0;
      pendingAllowHidden = false;
      controller?.abort(requestAbortedError());
      setPendingUserStateUpload(false);
    } else if (isAppActive()) {
      restart(false);
    }
  });
  const unsubscribeLifecycle = subscribeAppLifecycle(onAppLifecycleChange);
  restart();
  return () => {
    disposed = true;
    generation++;
    clearTimer();
    setPendingUserStateUpload(false);
    if (invalidateTimer !== undefined) clearTimeout(invalidateTimer);
    controller?.abort(requestAbortedError());
    unsubscribeConfig();
    unsubscribeEnabled();
    unsubscribeChanges();
    unsubscribeFlush();
    unsubscribeApplied();
    setUserStateActiveServer(null);
    unsubscribeNetwork();
    unsubscribeSuspended();
    unsubscribeLifecycle();
  };
}
