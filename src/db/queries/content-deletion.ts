import { getDb, runDatabaseTransaction } from "../client";
import type { NovelMetadataV1 } from "../../lib/work-metadata";
import { getNovelById, type NovelDetailRecord } from "./novel";

export async function listStoredDeletionNovelIds(): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(`SELECT n.id FROM novel n WHERE n.is_local=0 AND EXISTS(
    SELECT 1 FROM chapter c WHERE c.novel_id=n.id AND (c.is_downloaded=1 OR c.media_repair_needed=1))`);
  return rows.map(row => row.id);
}

export async function findLocalDeletionNovel(identity: NovelMetadataV1["identity"]): Promise<NovelDetailRecord | null> {
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(
    "SELECT id FROM novel WHERE plugin_id=$1 AND source_novel_id=$2",
    [identity.pluginId, identity.novelId],
  );
  return rows[0] ? getNovelById(rows[0].id) : null;
}

export async function deleteLocalNovelRecords(novel: Pick<NovelDetailRecord, "id" | "pluginId" | "sourceNovelId" | "path">): Promise<void> {
  await runDatabaseTransaction(async db => {
    const [current] = await db.select<{ pluginId: string; sourceNovelId: string | null; path: string }[]>(
      "SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE id=$1", [novel.id],
    );
    if (!current) return;
    if (current.pluginId !== novel.pluginId || current.sourceNovelId !== novel.sourceNovelId || current.path !== novel.path) {
      throw new Error("Local work identity changed before deletion.");
    }
    await db.execute("DELETE FROM novel WHERE id=$1", [novel.id]);
    await db.execute("DELETE FROM work_metadata_reading_state WHERE plugin_id=$1 AND novel_path=$2", [novel.pluginId, novel.path]);
    await db.execute("DELETE FROM content_sync_cache WHERE cache_key=$1", [`norea-content-source:${novel.id}`]);
  });
}
