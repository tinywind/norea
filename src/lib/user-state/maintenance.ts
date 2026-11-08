import { requestAbortedError } from "../abort";

// This serializes only cloud sharing and explicit restore. No SQLite transaction,
// download lock, storage lock, or provider request is held while waiting on the network.
let tail: Promise<unknown> = Promise.resolve();
let restoreRequests = 0;
const activeCancellations = new Set<() => void>();

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const result = tail.then(run);
  tail = result.catch(() => undefined);
  return result;
}

export function serializeUserStateSynchronization<T>(
  run: () => Promise<T>, cancel: () => void, signal: AbortSignal,
): Promise<T> {
  return enqueue(async () => {
    signal.throwIfAborted();
    if (restoreRequests > 0) throw requestAbortedError();
    activeCancellations.add(cancel);
    try { return await run(); }
    finally { activeCancellations.delete(cancel); }
  });
}

/** A restore aborts active traffic, awaits its settlement, then installs its durable DB fence. */
export function withUserStateRestore<T>(run: () => Promise<T>): Promise<T> {
  restoreRequests++;
  for (const cancel of activeCancellations) cancel();
  return enqueue(run).finally(() => { restoreRequests--; });
}
