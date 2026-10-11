let storageQueue: Promise<unknown> = Promise.resolve();

export function runContentStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.catch(() => undefined).then(operation);
  storageQueue = result;
  return result;
}
