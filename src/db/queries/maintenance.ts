import { getDb } from "../client";

export interface MaintenanceResult {
  rowsAffected: number;
}

export async function clearLibraryMembership(): Promise<MaintenanceResult> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE novel
     SET
       in_library = 0,
       library_added_at = NULL,
       updated_at = unixepoch()
     WHERE in_library = 1
       OR library_added_at IS NOT NULL`,
  );
  return { rowsAffected: result.rowsAffected };
}

export async function clearDownloadedChapterContent(): Promise<MaintenanceResult> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE chapter
     SET
       content_bytes = 0,
       media_bytes = 0,
       media_repair_needed = 0,
       media_bytes_checked_at = NULL,
       is_downloaded = 0,
       updated_at = unixepoch()
     WHERE (
         content_bytes > 0
         OR media_bytes > 0
         OR media_repair_needed = 1
         OR is_downloaded = 1
       )
       AND EXISTS (
         SELECT 1 FROM novel n
         WHERE n.id = chapter.novel_id
           AND n.is_local = 0
       )`,
  );
  return { rowsAffected: result.rowsAffected };
}

export async function clearUpdatesTab(): Promise<MaintenanceResult> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE chapter
     SET unread = 0, updated_at = unixepoch()
     WHERE unread = 1
       AND novel_id IN (
         SELECT id FROM novel WHERE in_library = 1
       )
       AND COALESCE(created_at, updated_at) >= (
         SELECT COALESCE(library_added_at, updated_at, created_at)
         FROM novel
         WHERE novel.id = chapter.novel_id
       )`,
  );
  return { rowsAffected: result.rowsAffected };
}

export async function clearReadingProgress(): Promise<MaintenanceResult> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE chapter
     SET
       progress = 0,
       unread = 1,
       read_at = NULL,
       updated_at = unixepoch()
     WHERE progress <> 0
       OR unread = 0
       OR read_at IS NOT NULL`,
  );
  await db.execute(
    `UPDATE novel
     SET last_read_at = NULL, updated_at = unixepoch()
     WHERE last_read_at IS NOT NULL`,
  );
  return { rowsAffected: result.rowsAffected };
}
