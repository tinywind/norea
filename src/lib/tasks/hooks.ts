import { useSyncExternalStore } from "react";
import { taskScheduler, type TaskSnapshot } from "./scheduler";
import { getVpnDownloadRuntimeSnapshot, subscribeVpnDownloadRuntime } from "./vpn-download-runtime";
import { getChapterDownloadRequestSnapshot, subscribeChapterDownloadRequests } from "./chapter-download-requests";
import { getChapterDownloadFailureSnapshot, subscribeChapterDownloadFailures } from "./chapter-download-failures";

function subscribeInactiveTaskSnapshot(): () => void {
  return () => undefined;
}

export function useTaskSnapshot(active = true): TaskSnapshot {
  return useSyncExternalStore(
    active ? taskScheduler.subscribe : subscribeInactiveTaskSnapshot,
    taskScheduler.getSnapshot,
    taskScheduler.getSnapshot,
  );
}

let taskBadgeCounts = { active: 0, failed: 0 };

function getTaskBadgeCounts() {
  const { queued, running, failed } = taskScheduler.getSnapshot();
  const active = queued + running;
  if (taskBadgeCounts.active !== active || taskBadgeCounts.failed !== failed) {
    taskBadgeCounts = { active, failed };
  }
  return taskBadgeCounts;
}

export function useTaskBadgeCounts() {
  return useSyncExternalStore(taskScheduler.subscribe, getTaskBadgeCounts, getTaskBadgeCounts);
}

export function useVpnDownloadRuntimeSnapshot(active = true) {
  return useSyncExternalStore(
    active ? subscribeVpnDownloadRuntime : subscribeInactiveTaskSnapshot,
    getVpnDownloadRuntimeSnapshot,
    getVpnDownloadRuntimeSnapshot,
  );
}

export function useChapterDownloadRequestSnapshot(active = true) {
  return useSyncExternalStore(
    active ? subscribeChapterDownloadRequests : subscribeInactiveTaskSnapshot,
    getChapterDownloadRequestSnapshot,
    getChapterDownloadRequestSnapshot,
  );
}

/** Persisted chapter download failures, refreshed after every recorded or cleared failure. */
export function useChapterDownloadFailureSnapshot(active = true) {
  return useSyncExternalStore(
    active ? subscribeChapterDownloadFailures : subscribeInactiveTaskSnapshot,
    getChapterDownloadFailureSnapshot,
    getChapterDownloadFailureSnapshot,
  );
}
