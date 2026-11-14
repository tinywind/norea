const listeners = new Set<() => void>();
let notifiedSequence = 0;

export function subscribeContentSyncChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyContentSyncSequence(sequence: number): void {
  if (sequence === notifiedSequence) return;
  notifiedSequence = sequence;
  for (const listener of listeners) listener();
}

export function resetContentSyncJournalNotification(): void {
  notifiedSequence = 0;
}
