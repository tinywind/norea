import { useSyncExternalStore } from "react";
import { taskScheduler, type TaskSnapshot } from "./scheduler";

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
