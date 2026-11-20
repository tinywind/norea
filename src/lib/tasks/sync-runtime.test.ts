import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ android: false }));
vi.mock("../tauri-runtime", () => ({
  isAndroidRuntime: () => runtime.android,
}));

import {
  formatContentSyncErrorSummary,
  formatUserStateErrorSummary,
} from "../content-sync/error-summary";
import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import type { TaskNotificationTranslate } from "./task-notification-model";
import {
  RECENT_FAILURE_OPEN_GRACE_MS,
  USER_STATE_FOREGROUND_GRACE_MS,
  beginContentSyncRun,
  beginPendingReaderWrite,
  beginSuspendingSyncFlush,
  beginUserStateSyncRun,
  buildContentSyncNotificationGroup,
  buildSyncFailureNotification,
  clearBackgroundSyncFailure,
  clearResolvedOpenedSyncBackgroundFailures,
  consumeDeferredContentUploadDueToDownload,
  getSyncRuntimeSnapshot,
  markDeferredContentUploadDueToDownload,
  markSyncFailureNotificationOpened,
  recordBackgroundSyncFailure,
  resetSyncRuntimeForTests,
  setContentSyncRuntimeProgress,
  setPendingContentSyncUpload,
  setPendingReaderProgress,
  setPendingUserStateUpload,
  subscribeSyncRuntime,
} from "./sync-runtime";

const t: TaskNotificationTranslate = (key, params) =>
  params && Object.keys(params).length > 0
    ? `${key}:${JSON.stringify(params)}`
    : key;

let browserWindow: EventTarget & {
  __NoreaAndroidTasks?: {
    isAppActive?: () => boolean;
    setPendingBackgroundUpload?: (pending: boolean) => void;
  };
};
let documentTarget: EventTarget;
let visibilityState: DocumentVisibilityState;
let setPendingBackgroundUpload: ReturnType<typeof vi.fn<(pending: boolean) => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  resetSyncRuntimeForTests();
  runtime.android = false;
  visibilityState = "visible";
  setPendingBackgroundUpload = vi.fn();
  browserWindow = Object.assign(new EventTarget(), {
    __NoreaAndroidTasks: {
      isAppActive: () => visibilityState !== "hidden",
      setPendingBackgroundUpload,
    },
  });
  documentTarget = new EventTarget();
  Object.defineProperty(documentTarget, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", documentTarget);
  useContentSyncStore.setState({
    ...useContentSyncStore.getInitialState(),
    serverUrl: "http://server",
  });
  useUserStateStore.setState({
    enabledByServer: {},
    runtimeByServer: {},
  });
});

afterEach(() => {
  resetSyncRuntimeForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sync-runtime", () => {
  it("combines content and user-state sync into one non-pausable card with ref-counting", () => {
    const endContent1 = beginContentSyncRun();
    const endContent2 = beginContentSyncRun();
    expect(buildContentSyncNotificationGroup(t)).toEqual({
      key: "contentSync",
      title: "tasks.notification.contentSync",
      body: "tasks.notification.contentSyncWorks",
      paused: false,
      pausable: false,
      progress: undefined,
      route: "/settings?section=backup",
    });

    const endUserState = beginUserStateSyncRun();
    expect(buildContentSyncNotificationGroup(t)?.body).toBe(
      "tasks.notification.contentSyncBoth",
    );

    setContentSyncRuntimeProgress({ completed: 3, total: 10, uploaded: 2, failed: 0 });
    expect(buildContentSyncNotificationGroup(t)).toMatchObject({
      key: "contentSync",
      pausable: false,
      progress: { current: 3, total: 10 },
      body: 'contentSync.progress:{"completed":3,"total":10,"uploaded":2,"failed":0}',
    });

    endContent1();
    expect(getSyncRuntimeSnapshot().contentSyncActive).toBe(true);
    endContent2();
    expect(getSyncRuntimeSnapshot().contentSyncActive).toBe(false);
    expect(getSyncRuntimeSnapshot().contentProgress).toBeNull();
    expect(buildContentSyncNotificationGroup(t)).toMatchObject({
      key: "contentSync",
      body: "userState.syncing",
      progress: undefined,
    });

    endUserState();
    expect(getSyncRuntimeSnapshot().executionActive).toBe(false);
    expect(buildContentSyncNotificationGroup(t)).toBeNull();
  });

  it("hides brief foreground user-state syncs during grace and promotes immediately on pause", () => {
    const notifications = vi.fn();
    const unsubscribe = subscribeSyncRuntime(notifications);
    const endFast = beginUserStateSyncRun();
    expect(getSyncRuntimeSnapshot()).toMatchObject({
      active: true,
      userStateActive: true,
      executionActive: false,
      showCard: false,
    });
    expect(buildContentSyncNotificationGroup(t)).toBeNull();

    vi.advanceTimersByTime(USER_STATE_FOREGROUND_GRACE_MS - 1);
    expect(getSyncRuntimeSnapshot().showCard).toBe(false);
    endFast();
    vi.advanceTimersByTime(10);
    expect(getSyncRuntimeSnapshot().showCard).toBe(false);

    const endLong = beginUserStateSyncRun();
    vi.advanceTimersByTime(USER_STATE_FOREGROUND_GRACE_MS);
    expect(getSyncRuntimeSnapshot().showCard).toBe(true);
    expect(buildContentSyncNotificationGroup(t)?.body).toBe("userState.syncing");
    endLong();

    const endPaused = beginUserStateSyncRun();
    expect(getSyncRuntimeSnapshot().showCard).toBe(false);
    visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(getSyncRuntimeSnapshot().showCard).toBe(true);
    expect(getSyncRuntimeSnapshot().executionActive).toBe(true);
    endPaused();
    unsubscribe();
    expect(notifications).toHaveBeenCalled();
  });

  it("publishes pending background upload hints to Android across all upload sources", () => {
    setPendingReaderProgress(true);
    expect(getSyncRuntimeSnapshot().hasPendingBackgroundUpload).toBe(false);

    useUserStateStore.getState().setEnabled("http://server", true);
    setPendingReaderProgress(false);
    setPendingReaderProgress(true);
    expect(getSyncRuntimeSnapshot().hasPendingBackgroundUpload).toBe(true);
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(true);
    setPendingReaderProgress(false);
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(false);

    const endReaderWrite = beginPendingReaderWrite();
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(true);
    endReaderWrite();
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(false);

    setPendingContentSyncUpload(true);
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(true);
    setPendingContentSyncUpload(false);
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(false);

    markDeferredContentUploadDueToDownload();
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(true);
    expect(consumeDeferredContentUploadDueToDownload()).toBe(true);
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(false);

    setPendingUserStateUpload(true);
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(true);
    setPendingUserStateUpload(false);
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(false);

    const endFlush = beginSuspendingSyncFlush();
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(true);
    endFlush();
    expect(setPendingBackgroundUpload).toHaveBeenLastCalledWith(false);
  });

  it("keeps notification and settings failure messages identical and survives auto-resume after open", () => {
    const rawNetworkError =
      "Work / Chapter 1: request or response body error for url (http://server/api/v1/chapter-files)";
    recordBackgroundSyncFailure({
      kind: "content",
      serverUrl: "http://server",
      rawError: rawNetworkError,
      blocked: false,
    });

    const contentFailure = getSyncRuntimeSnapshot().latestFailure!;
    expect(buildSyncFailureNotification(contentFailure, t)).toEqual({
      key: "contentSync",
      title: "tasks.notification.contentSyncFailed",
      body: formatContentSyncErrorSummary(rawNetworkError, false, t),
      action: { type: "openBackupSettings" },
    });
    expect(useContentSyncStore.getState()).toMatchObject({
      backgroundError: rawNetworkError,
      backgroundBlocked: false,
    });

    markSyncFailureNotificationOpened();
    clearBackgroundSyncFailure("content", "http://server");
    // Still displayed on Settings after an automatic foreground retry succeeded.
    expect(useContentSyncStore.getState().backgroundError).toBe(rawNetworkError);
    expect(getSyncRuntimeSnapshot().failureClearedSerial).toBe(0);

    clearResolvedOpenedSyncBackgroundFailures();
    expect(useContentSyncStore.getState().backgroundError).toBeNull();
    expect(getSyncRuntimeSnapshot().latestFailure).toBeNull();
    expect(getSyncRuntimeSnapshot().failureClearedSerial).toBe(1);

    recordBackgroundSyncFailure({
      kind: "userState",
      serverUrl: "http://server",
      rawError: "HTTP 403",
      blocked: true,
    });
    const userStateFailure = getSyncRuntimeSnapshot().latestFailure!;
    expect(buildSyncFailureNotification(userStateFailure, t).body).toBe(
      formatUserStateErrorSummary("HTTP 403", true, t),
    );
    expect(useUserStateStore.getState().runtimeByServer["http://server"]).toMatchObject({
      backgroundError: "HTTP 403",
      backgroundBlocked: true,
    });

    clearBackgroundSyncFailure("userState", "http://server", { force: true });
    expect(useUserStateStore.getState().runtimeByServer["http://server"]?.backgroundError).toBeUndefined();
    expect(getSyncRuntimeSnapshot().failureClearedSerial).toBe(2);
  });

  it("promotes user-state foreground grace when content sync overlaps so the unified card does not flicker", () => {
    const endUserState = beginUserStateSyncRun();
    expect(getSyncRuntimeSnapshot().showCard).toBe(false);

    const endContent = beginContentSyncRun();
    expect(getSyncRuntimeSnapshot().showCard).toBe(true);

    // Finishing content sync before the 1.5s grace expires keeps the card visible for user-state.
    endContent();
    expect(getSyncRuntimeSnapshot().showCard).toBe(true);
    expect(buildContentSyncNotificationGroup(t)?.body).toBe("userState.syncing");

    endUserState();
    expect(getSyncRuntimeSnapshot().showCard).toBe(false);
  });

  it("restores a recently auto-cleared background failure when the notification click arrives slightly after resume", () => {
    recordBackgroundSyncFailure({
      kind: "content",
      serverUrl: "http://server",
      rawError: "network timeout",
      blocked: false,
    });
    const emittedId = getSyncRuntimeSnapshot().latestFailure!.id;

    // Fast foreground auto-resume clears the failure moments before the OS deep-link arrives.
    clearBackgroundSyncFailure("content", "http://server");
    expect(useContentSyncStore.getState().backgroundError).toBeNull();
    expect(getSyncRuntimeSnapshot().latestFailure).toBeNull();

    vi.advanceTimersByTime(500);
    markSyncFailureNotificationOpened();
    expect(useContentSyncStore.getState().backgroundError).toBe("network timeout");
    // Restoring for Settings display does not re-emit a new notification.
    expect(getSyncRuntimeSnapshot().latestFailure).toBeNull();

    clearResolvedOpenedSyncBackgroundFailures();
    expect(useContentSyncStore.getState().backgroundError).toBeNull();

    // After the grace window (or on a forced clear), opening backup settings does not resurrect stale errors.
    recordBackgroundSyncFailure({
      kind: "content",
      serverUrl: "http://server",
      rawError: "expired error",
      blocked: false,
    });
    expect(getSyncRuntimeSnapshot().latestFailure!.id).toBeGreaterThan(emittedId);
    clearBackgroundSyncFailure("content", "http://server");
    vi.advanceTimersByTime(RECENT_FAILURE_OPEN_GRACE_MS + 1);
    markSyncFailureNotificationOpened();
    expect(useContentSyncStore.getState().backgroundError).toBeNull();

    recordBackgroundSyncFailure({
      kind: "content",
      serverUrl: "http://server",
      rawError: "manually cleared error",
      blocked: false,
    });
    clearBackgroundSyncFailure("content", "http://server", { force: true });
    markSyncFailureNotificationOpened();
    expect(useContentSyncStore.getState().backgroundError).toBeNull();
  });

  it("does not request a preemptive reader upload anchor when user-state sync is blocked with 403", () => {
    useUserStateStore.getState().setEnabled("http://server", true);
    useUserStateStore.getState().setRuntime("http://server", "error", "HTTP 403", true);
    setPendingReaderProgress(true);
    expect(getSyncRuntimeSnapshot().hasPendingBackgroundUpload).toBe(false);
    setPendingReaderProgress(false);
  });

  it("assigns a fresh monotonic id when promoting a remaining background failure after the latest one recovers", () => {
    recordBackgroundSyncFailure({
      kind: "content",
      serverUrl: "http://server",
      rawError: "Content upload failed",
      blocked: false,
    });
    const contentId = getSyncRuntimeSnapshot().latestFailure!.id;

    recordBackgroundSyncFailure({
      kind: "userState",
      serverUrl: "http://server",
      rawError: "HTTP 403",
      blocked: true,
    });
    const userStateId = getSyncRuntimeSnapshot().latestFailure!.id;
    expect(userStateId).toBeGreaterThan(contentId);

    // Clearing the newer userState failure promotes content with a fresh id > userStateId.
    clearBackgroundSyncFailure("userState", "http://server");
    const promoted = getSyncRuntimeSnapshot().latestFailure!;
    expect(promoted).toMatchObject({
      kind: "content",
      rawError: "Content upload failed",
      blocked: false,
    });
    expect(promoted.id).toBeGreaterThan(userStateId);
    expect(getSyncRuntimeSnapshot().failureClearedSerial).toBe(0);
    expect(buildSyncFailureNotification(promoted, t).body).toBe(
      formatContentSyncErrorSummary("Content upload failed", false, t),
    );

    // Clearing a non-latest failure does not bump the already-displayed failure id.
    recordBackgroundSyncFailure({
      kind: "userState",
      serverUrl: "http://server",
      rawError: "User state timeout",
      blocked: false,
    });
    const newestUserStateId = getSyncRuntimeSnapshot().latestFailure!.id;
    expect(newestUserStateId).toBeGreaterThan(promoted.id);

    clearBackgroundSyncFailure("content", "http://server");
    expect(getSyncRuntimeSnapshot().latestFailure).toMatchObject({
      id: newestUserStateId,
      kind: "userState",
      rawError: "User state timeout",
    });

    // Simultaneously clearing two resolved failures on Settings exit clears once without flashing.
    recordBackgroundSyncFailure({
      kind: "content",
      serverUrl: "http://server",
      rawError: "Second content failure",
      blocked: false,
    });
    markSyncFailureNotificationOpened();
    clearBackgroundSyncFailure("content", "http://server");
    clearBackgroundSyncFailure("userState", "http://server");
    const seenLatest: Array<string | null> = [];
    const unsubscribe = subscribeSyncRuntime(() => {
      seenLatest.push(getSyncRuntimeSnapshot().latestFailure?.kind ?? null);
    });
    clearResolvedOpenedSyncBackgroundFailures();
    unsubscribe();
    expect(seenLatest).toEqual([null]);
    expect(getSyncRuntimeSnapshot().latestFailure).toBeNull();
    expect(getSyncRuntimeSnapshot().failureClearedSerial).toBe(1);
  });
});
