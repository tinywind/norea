import type Database from "@tauri-apps/plugin-sql";

const listeners = new Set<() => void>();
let notifiedSequence = 0;

export function subscribeContentSyncChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function notifyContentSyncChanges(db: Database): Promise<void> {
  const rows = await db.select<{ sequence: number }[]>("SELECT COALESCE(MAX(sequence),0) AS sequence FROM content_sync_journal");
  const sequence = rows[0]?.sequence ?? 0;
  if (sequence === notifiedSequence) return;
  notifiedSequence = sequence;
  for (const listener of listeners) listener();
}
