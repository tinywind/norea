import { hasUserStateSchema, recordChapterUnreadFlagsInDb, recordLibraryInDb, recordNovelChaptersInDb, recordResumeClearedInDb } from "../user-state-core";
import { getDb, runDatabaseTransaction } from "../client";

export interface MaintenanceResult {
  rowsAffected: number;
}

export async function clearLibraryMembership(): Promise<MaintenanceResult> {
  return runDatabaseTransaction(async (db) => {

  await db.execute("DELETE FROM novel_download_goal WHERE novel_id IN (SELECT id FROM novel WHERE in_library = 1)");
  const result = await db.execute(
    `UPDATE novel
     SET
       in_library = 0,
       library_added_at = NULL,
       updated_at = unixepoch()
     WHERE in_library = 1
       OR library_added_at IS NOT NULL`,
  );
  await recordLibraryInDb(db);
  return { rowsAffected: result.rowsAffected };

  });
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
  return runDatabaseTransaction(async (db) => {

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
  if (await hasUserStateSchema(db)) {
    const rows = await db.select<{ id: number }[]>(`SELECT c.id FROM chapter c JOIN novel n ON n.id=c.novel_id
      WHERE n.in_library=1 AND COALESCE(c.created_at,c.updated_at)>=COALESCE(n.library_added_at,n.updated_at,n.created_at)`);
    await recordChapterUnreadFlagsInDb(db, rows.map(row => row.id), false);
  }
  return { rowsAffected: result.rowsAffected };

  });
}

export async function clearReadingProgress(): Promise<MaintenanceResult> {
  return runDatabaseTransaction(async (db) => {

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
  await recordNovelChaptersInDb(db);
  await recordResumeClearedInDb(db);
  return { rowsAffected: result.rowsAffected };

  });
}
