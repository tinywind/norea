import { getDb, runDatabaseTransaction } from "../client";
import type { NovelMetadataV1 } from "../../lib/work-metadata";
import { sqliteBoolean } from "../sqlite-value";
import {
  chapterReference,
  chapterWork,
  hasUserStateSchema,
  recordChapterRowsInDb,
  recordLibraryInDb,
  recordMembershipInDb,
  recordResumeClearedInDb,
  USER_CHAPTER_SELECT,
  type UserChapterRow,
} from "../user-state-core";
import { userStateEntityKey } from "../../lib/user-state/types";
import { getNovelById, type NovelDetailRecord } from "./novel";

export async function listStoredDeletionNovelIds(): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(`SELECT n.id FROM novel n WHERE n.is_local=0 AND EXISTS(
    SELECT 1 FROM chapter c WHERE c.novel_id=n.id AND (c.is_downloaded=1 OR c.media_repair_needed=1))`);
  return rows.map(row => row.id);
}

/** Stored chapters of source works, optionally only of these works, that a device download deletion removes. */
export async function listDeletionDownloadedChapterIds(novelIds?: readonly number[]): Promise<number[]> {
  const db = await getDb();
  const stored = "SELECT c.id FROM chapter c JOIN novel n ON n.id=c.novel_id WHERE n.is_local=0 AND (c.is_downloaded=1 OR c.content_bytes>0 OR c.media_repair_needed=1)";
  if (!novelIds) return (await db.select<{ id: number }[]>(`${stored} ORDER BY c.id`)).map(row => row.id);
  const unique = [...new Set(novelIds)];
  const ids: number[] = [];
  for (let index = 0; index < unique.length; index += 500) {
    const chunk = unique.slice(index, index + 500);
    const rows = await db.select<{ id: number }[]>(
      `${stored} AND c.novel_id IN (${chunk.map((_, offset) => `$${offset + 1}`).join(",")})`, chunk);
    ids.push(...rows.map(row => row.id));
  }
  return ids.sort((left, right) => left - right);
}

export async function findLocalDeletionNovel(identity: NovelMetadataV1["identity"]): Promise<NovelDetailRecord | null> {
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(
    "SELECT id FROM novel WHERE plugin_id=$1 AND source_novel_id=$2",
    [identity.pluginId, identity.novelId],
  );
  return rows[0] ? getNovelById(rows[0].id) : null;
}

export async function deleteLocalNovelRecords(
  novel: Pick<NovelDetailRecord, "id" | "pluginId" | "sourceNovelId" | "path">,
  options: { recordUserStateRemoval?: boolean } = {},
): Promise<void> {
  await runDatabaseTransaction(async db => {
    const [current] = await db.select<{ pluginId: string; sourceNovelId: string | null; path: string; name: string; inLibrary: number; lastReadAt: number | null }[]>(
      "SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path,name,in_library AS inLibrary,last_read_at AS lastReadAt FROM novel WHERE id=$1", [novel.id],
    );
    if (!current) return;
    if (current.pluginId !== novel.pluginId || current.sourceNovelId !== novel.sourceNovelId || current.path !== novel.path) {
      throw new Error("Local work identity changed before deletion.");
    }
    if (options.recordUserStateRemoval && await hasUserStateSchema(db)) {
      const work = { pluginId: current.pluginId, sourceNovelId: current.sourceNovelId, novelPath: current.path, name: current.name };
      const categories = await db.select<{ id: number }[]>("SELECT category_id AS id FROM novel_category WHERE novel_id=$1", [novel.id]);
      for (const category of categories) await recordMembershipInDb(db, [novel.id], category.id, false);
      const libraryKey = userStateEntityKey({ kind: "library", work });
      const [hasLibraryState] = current.inLibrary
        ? [{ present: 1 }]
        : await db.select<{ present: number }[]>(
            "SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM user_state_intent WHERE entity_key=$1) OR EXISTS(SELECT 1 FROM user_state_record WHERE entity_key=$1)",
            [libraryKey],
          );
      if (hasLibraryState) await recordLibraryInDb(db, [novel.id], true);
      const resumeKey = userStateEntityKey({ kind: "resume", work });
      const [hasResumeState] = current.lastReadAt !== null
        ? [{ present: 1 }]
        : await db.select<{ present: number }[]>(
            "SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM user_state_intent WHERE entity_key=$1) OR EXISTS(SELECT 1 FROM user_state_record WHERE entity_key=$1) OR EXISTS(SELECT 1 FROM work_metadata_reading_state WHERE plugin_id=$2 AND novel_path=$3)",
            [resumeKey, current.pluginId, current.path],
          );
      if (hasResumeState) await recordResumeClearedInDb(db, [novel.id]);
      const chapters = await db.select<UserChapterRow[]>(
        USER_CHAPTER_SELECT + " WHERE c.novel_id=$1 AND (c.progress>0 OR c.unread=0 OR c.read_at IS NOT NULL OR c.bookmark=1)",
        [novel.id],
      );
      if (chapters.length) {
        const privateKeys = new Set(
          (await db.select<{ entityKey: string }[]>("SELECT entity_key AS entityKey FROM user_state_private"))
            .map(row => row.entityKey),
        );
        const readingResets = chapters
          .filter(row => (row.progress > 0 || row.unread === 0 || row.readAt !== null)
            && !privateKeys.has(userStateEntityKey({ kind: "reading", work: chapterWork(row), chapter: chapterReference(row) })))
          .map(row => ({ ...row, progress: 0, unread: 1, readAt: null }));
        if (readingResets.length) await recordChapterRowsInDb(db, readingResets, "reading");
        const bookmarkResets = chapters
          .filter(row => sqliteBoolean(row.bookmark))
          .map(row => ({ ...row, bookmark: 0 }));
        if (bookmarkResets.length) await recordChapterRowsInDb(db, bookmarkResets, "bookmark");
      }
    }
    await db.execute("DELETE FROM content_sync_cache WHERE cache_key IN (SELECT 'norea-content-chapter-source:' || id FROM chapter WHERE novel_id=$1)", [novel.id]);
    await db.execute("DELETE FROM novel WHERE id=$1", [novel.id]);
    await db.execute("DELETE FROM work_metadata_reading_state WHERE plugin_id=$1 AND novel_path=$2", [novel.pluginId, novel.path]);
    await db.execute("DELETE FROM content_sync_cache WHERE cache_key=$1", [`norea-content-source:${novel.id}`]);
  });
}
