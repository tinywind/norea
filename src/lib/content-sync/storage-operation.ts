let storageQueue: Promise<unknown> = Promise.resolve();
const workQueues = new Map<string, Promise<unknown>>();

export function runContentStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = Promise.allSettled([storageQueue, ...workQueues.values()]);
  const result = pending.then(operation);
  storageQueue = result;
  return result;
}

/** Serialize changes to one work while allowing other works to stay usable. */
export function runWorkContentStorageOperation<T>(pluginId: string, novelPath: string, operation: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([pluginId, novelPath]);
  const pending = Promise.allSettled([storageQueue, workQueues.get(key)]);
  const result = pending.then(operation).finally(() => {
    if (workQueues.get(key) === result) workQueues.delete(key);
  });
  workQueues.set(key, result);
  return result;
}
