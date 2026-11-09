const flushListeners = new Set<() => void>();

/** Requests an immediate best-effort upload after the caller's local writes have committed. */
export function requestUserStateFlush(): void {
  for (const listener of flushListeners) listener();
}

export function subscribeUserStateFlush(listener: () => void): () => void {
  flushListeners.add(listener);
  return () => flushListeners.delete(listener);
}
