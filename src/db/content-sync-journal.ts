import type Database from "@tauri-apps/plugin-sql";

const listeners = new Set<() => void>();
let notifiedSequence = 0;

export function subscribeContentSyncChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyContentSyncSequence(sequence: number): void {
  if (sequence === notifiedSequence) return;
  notifiedSequence = sequence;
  for (const listener of listeners) listener();
}

export function resetContentSyncJournalNotification(): void {
  notifiedSequence = 0;
}

export async function notifyContentSyncChanges(db: Database): Promise<void> {
  const rows = await db.select<{ sequence: number }[]>("SELECT COALESCE(MAX(sequence),0) AS sequence FROM content_sync_journal");
  notifyContentSyncSequence(rows[0]?.sequence ?? 0);
}
