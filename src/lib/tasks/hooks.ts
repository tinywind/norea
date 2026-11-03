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

function getTaskAttentionCount(): number {
  const { failed, queued, running } = taskScheduler.getSnapshot();
  return running + queued + failed;
}

/** Counts active (running or queued) and failed tasks for navigation badges. */
export function useTaskAttentionCount(): number {
  return useSyncExternalStore(
    taskScheduler.subscribe,
    getTaskAttentionCount,
    getTaskAttentionCount,
  );
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
