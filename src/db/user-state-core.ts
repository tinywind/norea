import {
  canonicalUserStateJson,
  type UserStateApplyEffects,
  type UserStateBinding,
} from "../lib/user-state/types";

export type UserStateChangePriority = "reading" | "normal";

const changes = new Set<(priority: UserStateChangePriority) => void>();
const ledgerChanges = new Set<() => void>();
const applied = new Set<(effects: UserStateApplyEffects) => void>();
let deferredRunner: (() => Promise<void>) | undefined;
let deferredNovelRecorder: ((novelIds: readonly number[]) => void) | undefined;
let runningDeferred = false;
let deferredRequestedWhileRunning = false;
let deferredTask: Promise<void> | null = null;

export function subscribeUserStateLedgerChanges(listener: () => void): () => void {
  ledgerChanges.add(listener);
  return () => ledgerChanges.delete(listener);
}

export function emitUserStateLedgerChanged(): void {
  for (const listener of ledgerChanges) listener();
}

export async function waitForUserStateDeferredApply(): Promise<void> {
  await deferredTask;
}

export const namespaceFor = (binding: UserStateBinding): string =>
  canonicalUserStateJson([binding.serverUrl, binding.workspaceId, binding.epoch]);

export function subscribeUserStateChanges(
  listener: (priority: UserStateChangePriority) => void,
): () => void {
  changes.add(listener);
  return () => changes.delete(listener);
}

export function subscribeUserStateApplied(
  listener: (effects: UserStateApplyEffects) => void,
): () => void {
  applied.add(listener);
  return () => applied.delete(listener);
}

export function emitUserStateApplied(effects: UserStateApplyEffects): void {
  for (const listener of applied) listener(effects);
}

export function installUserStateDeferredRunner(run: () => Promise<void>): void {
  deferredRunner = run;
}

export function installUserStateDeferredNovelRecorder(
  record: (novelIds: readonly number[]) => void,
): void {
  deferredNovelRecorder = record;
}

function scheduleDeferredUserStateApply(): void {
  if (runningDeferred) {
    deferredRequestedWhileRunning = true;
    return;
  }
  runningDeferred = true;
  // The writer queue must be released before projection starts. If another
  // transaction requests projection while this run is active, loop once more
  // rather than dropping that request.
  deferredTask = Promise.resolve()
    .then(async () => {
      do {
        deferredRequestedWhileRunning = false;
        await (
          deferredRunner ??
          (() =>
            import("./user-state").then((module) =>
              module.applyDeferredUserState(),
            ))
        )();
      } while (deferredRequestedWhileRunning);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.warn("[user-state] deferred state could not be applied", error);
    })
    .finally(() => {
      runningDeferred = false;
      deferredRequestedWhileRunning = false;
      deferredTask = null;
    });
}

export function notifyUserStateEffects(input: {
  priority?: UserStateChangePriority | null;
  ledgerChanged?: boolean;
  deferredReady?: boolean;
  deferredNovelIds?: readonly number[];
}): void {
  if (input.deferredNovelIds?.length) {
    deferredNovelRecorder?.(input.deferredNovelIds);
  }
  if (input.priority) {
    for (const listener of changes) listener(input.priority);
    emitUserStateLedgerChanged();
  } else if (input.ledgerChanged) {
    emitUserStateLedgerChanged();
  }
  if (input.deferredReady) {
    scheduleDeferredUserStateApply();
  }
}
