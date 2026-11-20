import { isAppActive, subscribeAppLifecycle } from "../app-lifecycle";
import {
  formatContentSyncErrorSummary,
  formatUserStateErrorSummary,
} from "../content-sync/error-summary";
import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import type { TaskNotificationAction } from "./native-notification-actions";
import type {
  ActiveTaskNotificationGroup,
  TaskNotificationTranslate,
} from "./task-notification-model";

export type SyncRuntimeKind = "content" | "userState";
export type SyncNotificationChannel = "android" | "windows";

export type ContentSyncRuntimeProgress = {
  completed: number;
  total: number;
  uploaded: number;
  failed: number;
};

export interface BackgroundSyncFailureRecord {
  id: number;
  kind: SyncRuntimeKind;
  serverUrl: string;
  rawError: string;
  blocked: boolean;
}

export interface SyncRuntimeSnapshot {
  active: boolean;
  contentSyncActive: boolean;
  userStateActive: boolean;
  executionActive: boolean;
  showCard: boolean;
  contentProgress: ContentSyncRuntimeProgress | null;
  hasPendingBackgroundUpload: boolean;
  latestFailure: BackgroundSyncFailureRecord | null;
  failureClearedSerial: number;
}

export interface SyncFailureNotificationPayload {
  action: TaskNotificationAction;
  body: string;
  key: "contentSync";
  title: string;
}

export const USER_STATE_FOREGROUND_GRACE_MS = 1_500;
export const RECENT_FAILURE_OPEN_GRACE_MS = 3_000;

let contentSyncCount = 0;
let userStateCount = 0;
let contentProgress: ContentSyncRuntimeProgress | null = null;
let userStateGraceElapsed = false;
let userStateGraceTimer: ReturnType<typeof setTimeout> | null = null;

let pendingContentUpload = false;
let pendingUserStateUpload = false;
let pendingReaderProgress = false;
let pendingReaderWriteCount = 0;
let suspendingFlushCount = 0;
let deferredContentUploadAfterDownload = false;
let lastNativePendingUpload: boolean | null = null;

let failureSerial = 0;
let failureClearedSerial = 0;
let latestFailure: BackgroundSyncFailureRecord | null = null;
const emittedFailureIdByChannel: Record<SyncNotificationChannel, number> = {
  android: 0,
  windows: 0,
};
const activeFailures: Partial<Record<SyncRuntimeKind, BackgroundSyncFailureRecord & {
  openedFromNotification: boolean;
  resolvedAfterOpen: boolean;
}>> = {};
const recentlyAutoClearedFailures: Partial<Record<SyncRuntimeKind, {
  record: BackgroundSyncFailureRecord;
  clearedAt: number;
}>> = {};

let backgroundExecutionSuspended = false;
let unsubscribeLifecycle: (() => void) | null = null;

const listeners = new Set<() => void>();
const suspensionListeners = new Set<(suspended: boolean) => void>();

function isUserStateAutoSyncEnabled(): boolean {
  const serverUrl = useContentSyncStore.getState?.()?.serverUrl;
  if (!serverUrl) return false;
  const userState = useUserStateStore.getState?.();
  if (!userState) return false;
  const runtime = userState.runtimeByServer[serverUrl];
  return userState.enabledByServer[serverUrl] === true &&
    !runtime?.epochMismatch &&
    !runtime?.blocked;
}

function computePendingBackgroundUpload(): boolean {
  if (contentSyncCount > 0 || userStateCount > 0 || suspendingFlushCount > 0) return true;
  if (pendingContentUpload || deferredContentUploadAfterDownload) return true;
  if (pendingUserStateUpload) return true;
  if ((pendingReaderProgress || pendingReaderWriteCount > 0) && isUserStateAutoSyncEnabled()) {
    return true;
  }
  return false;
}

function publishNativePendingUploadFlag(): void {
  const pending = computePendingBackgroundUpload();
  if (pending === lastNativePendingUpload) return;
  lastNativePendingUpload = pending;
  if (typeof window === "undefined") return;
  const bridge = window.__NoreaAndroidTasks as {
    setPendingBackgroundUpload?: (value: boolean) => void;
  } | undefined;
  bridge?.setPendingBackgroundUpload?.(pending);
}

function clearUserStateGraceTimer(): void {
  if (userStateGraceTimer !== null) {
    clearTimeout(userStateGraceTimer);
    userStateGraceTimer = null;
  }
}

function ensureLifecycleSubscription(): void {
  if (unsubscribeLifecycle) return;
  unsubscribeLifecycle = subscribeAppLifecycle((active) => {
    if (!active && userStateCount > 0 && !userStateGraceElapsed) {
      clearUserStateGraceTimer();
      userStateGraceElapsed = true;
      notify();
    }
  });
}

function maybeReleaseLifecycleSubscription(): void {
  if (listeners.size === 0 && contentSyncCount === 0 && userStateCount === 0) {
    unsubscribeLifecycle?.();
    unsubscribeLifecycle = null;
  }
}

function notify(): void {
  publishNativePendingUploadFlag();
  for (const listener of [...listeners]) listener();
}

export function subscribeSyncRuntime(listener: () => void): () => void {
  listeners.add(listener);
  ensureLifecycleSubscription();
  return () => {
    listeners.delete(listener);
    maybeReleaseLifecycleSubscription();
  };
}

export function getSyncRuntimeSnapshot(): SyncRuntimeSnapshot {
  const contentSyncActive = contentSyncCount > 0;
  const userStateActive = userStateCount > 0;
  const active = contentSyncActive || userStateActive;
  const executionActive =
    contentSyncActive || (userStateActive && (!isAppActive() || userStateGraceElapsed));
  return {
    active,
    contentSyncActive,
    userStateActive,
    executionActive,
    showCard: executionActive,
    contentProgress: contentSyncActive ? contentProgress : null,
    hasPendingBackgroundUpload: computePendingBackgroundUpload(),
    latestFailure,
    failureClearedSerial,
  };
}

export function beginContentSyncRun(): () => void {
  contentSyncCount += 1;
  if (userStateCount > 0 && !userStateGraceElapsed) {
    // Keep the already-shown unified card stable if content sync ends before user-state finishes.
    clearUserStateGraceTimer();
    userStateGraceElapsed = true;
  }
  ensureLifecycleSubscription();
  notify();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    contentSyncCount = Math.max(0, contentSyncCount - 1);
    if (contentSyncCount === 0) contentProgress = null;
    notify();
    maybeReleaseLifecycleSubscription();
  };
}

export function setContentSyncRuntimeProgress(
  progress: ContentSyncRuntimeProgress | null,
): void {
  if (contentSyncCount === 0) {
    contentProgress = null;
    return;
  }
  if (
    contentProgress?.completed === progress?.completed &&
    contentProgress?.total === progress?.total &&
    contentProgress?.uploaded === progress?.uploaded &&
    contentProgress?.failed === progress?.failed
  ) {
    return;
  }
  contentProgress = progress ? { ...progress } : null;
  notify();
}

export function beginUserStateSyncRun(): () => void {
  const wasZero = userStateCount === 0;
  userStateCount += 1;
  ensureLifecycleSubscription();
  if (wasZero) {
    clearUserStateGraceTimer();
    if (!isAppActive() || contentSyncCount > 0) {
      userStateGraceElapsed = true;
    } else {
      userStateGraceElapsed = false;
      userStateGraceTimer = setTimeout(() => {
        userStateGraceTimer = null;
        if (userStateCount > 0 && !userStateGraceElapsed) {
          userStateGraceElapsed = true;
          notify();
        }
      }, USER_STATE_FOREGROUND_GRACE_MS);
    }
  }
  notify();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    userStateCount = Math.max(0, userStateCount - 1);
    if (userStateCount === 0) {
      clearUserStateGraceTimer();
      userStateGraceElapsed = false;
    }
    notify();
    maybeReleaseLifecycleSubscription();
  };
}

export function setPendingContentSyncUpload(pending: boolean): void {
  if (pendingContentUpload === pending) return;
  pendingContentUpload = pending;
  publishNativePendingUploadFlag();
}

export function markDeferredContentUploadDueToDownload(): void {
  deferredContentUploadAfterDownload = true;
  publishNativePendingUploadFlag();
}

export function hasDeferredContentUploadDueToDownload(): boolean {
  return deferredContentUploadAfterDownload;
}

export function consumeDeferredContentUploadDueToDownload(): boolean {
  if (!deferredContentUploadAfterDownload) return false;
  deferredContentUploadAfterDownload = false;
  publishNativePendingUploadFlag();
  return true;
}

export function setPendingUserStateUpload(pending: boolean): void {
  if (pendingUserStateUpload === pending) return;
  pendingUserStateUpload = pending;
  publishNativePendingUploadFlag();
}

export function setPendingReaderProgress(pending: boolean): void {
  if (pendingReaderProgress === pending) return;
  pendingReaderProgress = pending;
  publishNativePendingUploadFlag();
}

export function beginPendingReaderWrite(): () => void {
  pendingReaderWriteCount += 1;
  publishNativePendingUploadFlag();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    pendingReaderWriteCount = Math.max(0, pendingReaderWriteCount - 1);
    publishNativePendingUploadFlag();
  };
}

export function beginSuspendingSyncFlush(): () => void {
  suspendingFlushCount += 1;
  publishNativePendingUploadFlag();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    suspendingFlushCount = Math.max(0, suspendingFlushCount - 1);
    notify();
  };
}

function applyBackgroundFailureToStore(
  kind: SyncRuntimeKind,
  serverUrl: string,
  rawError: string | null,
  blocked: boolean,
): void {
  if (kind === "content") {
    const current = useContentSyncStore.getState?.();
    if (!current) return;
    if (rawError === null || current.serverUrl === serverUrl) {
      useContentSyncStore.setState?.({
        backgroundError: rawError,
        backgroundBlocked: rawError === null ? false : blocked,
      });
    }
    return;
  }
  if (!serverUrl) return;
  useUserStateStore.getState?.()?.setBackgroundFailure?.(serverUrl, rawError, blocked);
}

export function recordBackgroundSyncFailure(input: {
  kind: SyncRuntimeKind;
  serverUrl: string;
  rawError: string;
  blocked: boolean;
}): void {
  delete recentlyAutoClearedFailures[input.kind];
  const existing = activeFailures[input.kind];
  const sameAsActive =
    existing !== undefined &&
    existing.serverUrl === input.serverUrl &&
    existing.rawError === input.rawError &&
    existing.blocked === input.blocked &&
    !existing.resolvedAfterOpen;

  applyBackgroundFailureToStore(input.kind, input.serverUrl, input.rawError, input.blocked);

  if (sameAsActive) {
    return;
  }
  const record: BackgroundSyncFailureRecord = {
    id: ++failureSerial,
    kind: input.kind,
    serverUrl: input.serverUrl,
    rawError: input.rawError,
    blocked: input.blocked,
  };
  activeFailures[input.kind] = {
    ...record,
    openedFromNotification: false,
    resolvedAfterOpen: false,
  };
  latestFailure = record;
  notify();
}

function reconcileLatestFailureAfterRemoval(): void {
  const remaining = Object.values(activeFailures).filter(
    (entry): entry is NonNullable<typeof entry> =>
      entry !== undefined && !entry.resolvedAfterOpen,
  );
  if (remaining.length === 0) {
    latestFailure = null;
    failureClearedSerial += 1;
  } else {
    remaining.sort((left, right) => right.id - left.id);
    const newest = remaining[0]!;
    const promoted =
      latestFailure === null ||
      latestFailure.kind !== newest.kind ||
      latestFailure.id !== newest.id;
    if (promoted) {
      // Assign a fresh monotonic id so Android/Windows bridges replace the resolved error card.
      newest.id = ++failureSerial;
    }
    latestFailure = {
      id: newest.id,
      kind: newest.kind,
      serverUrl: newest.serverUrl,
      rawError: newest.rawError,
      blocked: newest.blocked,
    };
  }
  notify();
}

export function clearBackgroundSyncFailure(
  kind: SyncRuntimeKind,
  serverUrl?: string,
  options: { force?: boolean } = {},
): void {
  if (options.force) {
    delete recentlyAutoClearedFailures[kind];
  }
  const existing = activeFailures[kind];
  if (!existing) {
    if (options.force) {
      const targetServer = serverUrl ?? useContentSyncStore.getState?.()?.serverUrl ?? "";
      applyBackgroundFailureToStore(kind, targetServer, null, false);
    }
    return;
  }
  if (serverUrl && existing.serverUrl !== serverUrl && !options.force) return;

  if (!options.force && existing.openedFromNotification) {
    existing.resolvedAfterOpen = true;
    return;
  }

  if (!options.force) {
    recentlyAutoClearedFailures[kind] = {
      record: {
        id: existing.id,
        kind: existing.kind,
        serverUrl: existing.serverUrl,
        rawError: existing.rawError,
        blocked: existing.blocked,
      },
      clearedAt: Date.now(),
    };
  }

  delete activeFailures[kind];
  applyBackgroundFailureToStore(kind, existing.serverUrl, null, false);
  reconcileLatestFailureAfterRemoval();
}

export function markSyncFailureNotificationOpened(): void {
  const now = Date.now();
  const activeServerUrl = useContentSyncStore.getState?.()?.serverUrl;
  for (const kind of ["content", "userState"] as const) {
    const entry = activeFailures[kind];
    if (entry) {
      entry.openedFromNotification = true;
      continue;
    }
    const recentlyCleared = recentlyAutoClearedFailures[kind];
    if (!recentlyCleared) continue;
    delete recentlyAutoClearedFailures[kind];
    if (now - recentlyCleared.clearedAt > RECENT_FAILURE_OPEN_GRACE_MS) continue;
    if (activeServerUrl && recentlyCleared.record.serverUrl !== activeServerUrl) continue;
    activeFailures[kind] = {
      ...recentlyCleared.record,
      openedFromNotification: true,
      resolvedAfterOpen: true,
    };
    applyBackgroundFailureToStore(
      kind,
      recentlyCleared.record.serverUrl,
      recentlyCleared.record.rawError,
      recentlyCleared.record.blocked,
    );
  }
}

export function clearResolvedOpenedSyncBackgroundFailures(): void {
  let clearedAny = false;
  for (const kind of ["content", "userState"] as const) {
    const entry = activeFailures[kind];
    if (!entry || !entry.openedFromNotification) continue;
    entry.openedFromNotification = false;
    if (entry.resolvedAfterOpen) {
      delete recentlyAutoClearedFailures[kind];
      delete activeFailures[kind];
      applyBackgroundFailureToStore(kind, entry.serverUrl, null, false);
      clearedAny = true;
    }
  }
  if (clearedAny) {
    reconcileLatestFailureAfterRemoval();
  }
}

export function getLastEmittedSyncFailureId(channel: SyncNotificationChannel): number {
  return emittedFailureIdByChannel[channel];
}

export function markSyncFailureNotificationEmitted(
  channel: SyncNotificationChannel,
  id: number,
): void {
  if (id > emittedFailureIdByChannel[channel]) {
    emittedFailureIdByChannel[channel] = id;
  }
}

export function buildContentSyncNotificationGroup(
  t: TaskNotificationTranslate,
  snapshot: SyncRuntimeSnapshot = getSyncRuntimeSnapshot(),
): ActiveTaskNotificationGroup | null {
  if (!snapshot.showCard) return null;

  let body: string;
  let progress: ActiveTaskNotificationGroup["progress"];
  if (snapshot.contentSyncActive && snapshot.contentProgress && snapshot.contentProgress.total > 0) {
    body = t("contentSync.progress", snapshot.contentProgress);
    progress = {
      current: snapshot.contentProgress.completed,
      total: snapshot.contentProgress.total,
    };
  } else if (snapshot.contentSyncActive && snapshot.userStateActive) {
    body = t("tasks.notification.contentSyncBoth");
  } else if (snapshot.contentSyncActive) {
    body = t("tasks.notification.contentSyncWorks");
  } else {
    body = t("userState.syncing");
  }

  return {
    key: "contentSync",
    title: t("tasks.notification.contentSync"),
    body,
    paused: false,
    pausable: false,
    progress,
    route: "/settings?section=backup",
  };
}

export function buildSyncFailureNotification(
  failure: BackgroundSyncFailureRecord,
  t: TaskNotificationTranslate,
): SyncFailureNotificationPayload {
  const body = failure.kind === "content"
    ? formatContentSyncErrorSummary(failure.rawError, failure.blocked, t)
    : formatUserStateErrorSummary(failure.rawError, failure.blocked, t);
  return {
    key: "contentSync",
    title: t("tasks.notification.contentSyncFailed"),
    body,
    action: { type: "openBackupSettings" },
  };
}

export function isSyncBackgroundExecutionSuspended(): boolean {
  return backgroundExecutionSuspended;
}

export function setSyncBackgroundExecutionSuspended(suspended: boolean): void {
  if (backgroundExecutionSuspended === suspended) return;
  backgroundExecutionSuspended = suspended;
  for (const listener of [...suspensionListeners]) listener(suspended);
}

export function subscribeSyncBackgroundExecutionSuspended(
  listener: (suspended: boolean) => void,
): () => void {
  suspensionListeners.add(listener);
  return () => {
    suspensionListeners.delete(listener);
  };
}

/** Test hook: reset all runtime state. */
export function resetSyncRuntimeForTests(): void {
  clearUserStateGraceTimer();
  contentSyncCount = 0;
  userStateCount = 0;
  contentProgress = null;
  userStateGraceElapsed = false;
  pendingContentUpload = false;
  pendingUserStateUpload = false;
  pendingReaderProgress = false;
  pendingReaderWriteCount = 0;
  suspendingFlushCount = 0;
  deferredContentUploadAfterDownload = false;
  lastNativePendingUpload = null;
  failureSerial = 0;
  failureClearedSerial = 0;
  latestFailure = null;
  emittedFailureIdByChannel.android = 0;
  emittedFailureIdByChannel.windows = 0;
  delete activeFailures.content;
  delete activeFailures.userState;
  delete recentlyAutoClearedFailures.content;
  delete recentlyAutoClearedFailures.userState;
  backgroundExecutionSuspended = false;
  unsubscribeLifecycle?.();
  unsubscribeLifecycle = null;
  listeners.clear();
  suspensionListeners.clear();
}
