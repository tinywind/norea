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

const local = "(SELECT remote FROM content_sync_origin WHERE id=1)=0";
const chapter = (row: string) => `json_array(n.plugin_id,n.path,${row}.path)`;
const log = (key: string, value: string, from = "") => `INSERT INTO content_sync_journal(state_key,payload) SELECT ${key},${value} ${from};`;

export const CONTENT_SYNC_JOURNAL_SCHEMA: string[] = [
  "CREATE TABLE IF NOT EXISTS content_sync_origin(id integer PRIMARY KEY NOT NULL,remote integer NOT NULL DEFAULT 0)",
  "INSERT OR IGNORE INTO content_sync_origin(id,remote) VALUES(1,0)",
  "CREATE TABLE IF NOT EXISTS content_sync_journal(sequence integer PRIMARY KEY AUTOINCREMENT NOT NULL,state_key text NOT NULL,payload text NOT NULL)",
  "CREATE INDEX IF NOT EXISTS content_sync_journal_key_idx ON content_sync_journal(state_key,sequence)",
  "CREATE TABLE IF NOT EXISTS content_sync_position(novel_id integer PRIMARY KEY NOT NULL,chapter_id integer NOT NULL)",
];

// Retire personal-state triggers without removing their historical data.
for (const name of ["novel_insert", "novel_library", "novel_delete", "chapter_insert", "chapter_delete", "chapter_read", "chapter_bookmark", "chapter_position"]) {
  CONTENT_SYNC_JOURNAL_SCHEMA.push(`DROP TRIGGER IF EXISTS content_sync_${name}`);
}
CONTENT_SYNC_JOURNAL_SCHEMA.push(`CREATE TRIGGER IF NOT EXISTS content_sync_novel_content_delete BEFORE DELETE ON novel WHEN ${local} BEGIN
  ${log("'content:' || json_array(OLD.plugin_id,OLD.path,c.path)", "'null'", "FROM chapter c WHERE c.novel_id=OLD.id")}
END`);
CONTENT_SYNC_JOURNAL_SCHEMA.push(`CREATE TRIGGER IF NOT EXISTS content_sync_chapter_content_delete BEFORE DELETE ON chapter WHEN ${local} BEGIN
  ${log(`'content:' || ${chapter("OLD")}`, "'null'", "FROM novel n WHERE n.id=OLD.novel_id")}
END`);
for (const event of ["INSERT", "UPDATE OF is_downloaded,stored_content_type,content_bytes,media_bytes,media_repair_needed,name,chapter_number,position,page,content_type"] as const) {
  CONTENT_SYNC_JOURNAL_SCHEMA.push(`CREATE TRIGGER IF NOT EXISTS content_sync_chapter_content_${event === "INSERT" ? "insert" : "update"} AFTER ${event} ON chapter WHEN ${local}${event === "INSERT" ? " AND NEW.is_downloaded=1" : ""} BEGIN
    ${log(`'content:' || ${chapter("NEW")}`, "'null'", "FROM novel n WHERE n.id=NEW.novel_id")} END`);
}
CONTENT_SYNC_JOURNAL_SCHEMA.push(`CREATE TRIGGER IF NOT EXISTS content_sync_novel_metadata AFTER UPDATE OF name,author,summary,is_local ON novel WHEN ${local} BEGIN
  ${log("'content:' || json_array(NEW.plugin_id,NEW.path,c.path)", "'null'", "FROM chapter c WHERE c.novel_id=NEW.id AND c.is_downloaded=1")} END`);

export async function ensureContentSyncJournal(db: Database): Promise<void> {
  for (const statement of CONTENT_SYNC_JOURNAL_SCHEMA) await db.execute(statement);
}
