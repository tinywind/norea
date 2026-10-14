import type Database from "@tauri-apps/plugin-sql";
import { chapterStorageRelativeDir } from "../lib/chapter-storage-path";
import {
  finalizeChapterStorageTransfer,
  prepareChapterStorageTransfer,
  rollbackChapterStorageTransfer,
  type ChapterStorageTransferPreparation,
} from "../lib/chapter-storage-transfer";
import { LOCAL_NOVEL_NAME, LOCAL_NOVEL_PATH } from "../lib/local-library-identity";
import { isTauriRuntime } from "../lib/tauri-runtime";
import { availableNovelMetadataDirectory, listStoredNovelChapters, withWorkMetadataRollback } from "../lib/work-metadata";
import type { Chapter, Novel } from "./schema";
import { flushWorkMetadata, initializeWorkMetadata } from "./work-metadata";

type LocalNovel = Pick<Novel, "id" | "pluginId" | "path" | "name"> & { directory: string | null };
type LocalChapter = Pick<Chapter, "id" | "novelId" | "path" | "name" | "chapterNumber" | "position"> & { directory: string | null };

function planLocalChapterMoves(novels: LocalNovel[], chapters: LocalChapter[], canonical: LocalNovel, directory: string, occupiedDirectories: string[]) {
  const existing = chapters.filter((chapter) => chapter.novelId === canonical.id);
  const paths = new Set(existing.map((chapter) => chapter.path));
  const directories = new Set([
    ...existing.map((chapter) => chapter.directory ?? chapterStorageRelativeDir(canonical, chapter)),
    ...occupiedDirectories,
  ].map((value) => value.toLowerCase()));
  const novelsById = new Map(novels.map((novel) => [novel.id, novel]));
  let position = existing.reduce((maximum, chapter) => Math.max(maximum, chapter.position), 0);
  return chapters.filter((chapter) => chapter.novelId !== canonical.id).map((chapter) => {
    const source = novelsById.get(chapter.novelId)!;
    const sourceRelativeDir = chapter.directory ?? chapterStorageRelativeDir(source, chapter);
    let path = chapter.path;
    if (paths.has(path)) {
      const prefix = `${path}#local=${encodeURIComponent(JSON.stringify([source.pluginId, source.path]))}`;
      path = prefix;
      let suffix = 1;
      while (paths.has(path)) path = `${prefix}-${suffix++}`;
    }
    paths.add(path);
    position++;
    const child = chapterStorageRelativeDir(canonical, { name: chapter.name, chapterNumber: String(position), position }).split("/").at(-1)!;
    const preferred = `${directory}/${child}`;
    let targetRelativeDir = preferred;
    let suffix = 1;
    while (directories.has(targetRelativeDir.toLowerCase())) targetRelativeDir = `${preferred}-${suffix++}`;
    directories.add(targetRelativeDir.toLowerCase());
    return { chapterId: chapter.id, path, position, sourceRelativeDir, targetRelativeDir };
  });
}

export async function consolidateLocalLibrary(db: Database): Promise<void> {
  if (!isTauriRuntime()) return;
  const [candidate] = await db.select<{ id: number }[]>(
    `SELECT id FROM novel WHERE (plugin_id='local' OR is_local=1)
    AND (plugin_id<>'local' OR path<>$1 OR name<>$2 OR is_local<>1) LIMIT 1`,
    [LOCAL_NOVEL_PATH, LOCAL_NOVEL_NAME],
  );
  if (!candidate) return;

  let preparation: ChapterStorageTransferPreparation | undefined;
  await db.execute("BEGIN IMMEDIATE");
  try {
    await withWorkMetadataRollback(async () => {
      await db.execute(
        `INSERT INTO novel(plugin_id,path,name,is_local,in_library,created_at,updated_at,library_added_at,last_read_at)
        SELECT 'local',$1,$2,1,MAX(in_library),MIN(created_at),MAX(updated_at),MIN(library_added_at),MAX(last_read_at)
        FROM novel WHERE plugin_id='local' OR is_local=1
        ON CONFLICT(plugin_id,path) DO UPDATE SET name=excluded.name,is_local=1,in_library=excluded.in_library,
        created_at=excluded.created_at,updated_at=excluded.updated_at,library_added_at=excluded.library_added_at,last_read_at=excluded.last_read_at`,
        [LOCAL_NOVEL_PATH, LOCAL_NOVEL_NAME],
      );
      const novels = await db.select<LocalNovel[]>(
        `SELECT n.id,n.plugin_id AS pluginId,n.path,n.name,f.directory FROM novel n
        LEFT JOIN work_metadata_file_cache f ON f.novel_id=n.id
        WHERE n.plugin_id='local' OR n.is_local=1 ORDER BY n.id`,
      );
      const canonical = novels.find((novel) => novel.pluginId === "local" && novel.path === LOCAL_NOVEL_PATH)!;
      const directory = canonical.directory ?? await availableNovelMetadataDirectory({
        identity: { pluginId: "local", novelPath: LOCAL_NOVEL_PATH },
        novel: { name: LOCAL_NOVEL_NAME, author: null, artist: null, summary: null, status: null, genres: null, rating: null, isLocal: true },
      });
      const chapters = await db.select<LocalChapter[]>(
        `SELECT c.id,c.novel_id AS novelId,c.path,c.name,c.chapter_number AS chapterNumber,c.position,d.directory
        FROM chapter c JOIN novel n ON n.id=c.novel_id
        LEFT JOIN work_metadata_directory_cache d ON d.chapter_id=c.id
        WHERE n.plugin_id='local' OR n.is_local=1 ORDER BY n.id,c.position,c.id`,
      );
      const occupiedDirectories = chapters.some((chapter) => chapter.novelId !== canonical.id)
        ? (await listStoredNovelChapters(directory)).map((chapter) => `${directory}/${chapter.directory}`)
        : [];
      const moves = planLocalChapterMoves(novels, chapters, canonical, directory, occupiedDirectories);
      if (moves.length) {
        preparation = await prepareChapterStorageTransfer(moves.map((move) => ({
          entryId: String(move.chapterId), sourceRelativeDir: move.sourceRelativeDir, targetRelativeDir: move.targetRelativeDir,
        })));
        if (preparation.entries.some((entry) => entry.outcome === "keptTarget")) {
          throw new Error("Local chapter consolidation target already contains downloaded content.");
        }
      }
      const missingContent = new Set(preparation?.entries.filter((entry) => entry.outcome === "sourceNotDownloaded").map((entry) => entry.entryId));
      for (const move of moves) {
        await db.execute("UPDATE chapter SET novel_id=$1,path=$2,position=$3,chapter_number=$4 WHERE id=$5",
          [canonical.id, move.path, move.position, String(move.position), move.chapterId]);
        if (missingContent.has(String(move.chapterId))) {
          await db.execute(
            `UPDATE chapter SET is_downloaded=0,stored_content_type=NULL,content_bytes=0,media_bytes=0,
            media_repair_needed=0,media_bytes_checked_at=NULL WHERE id=$1`, [move.chapterId],
          );
        }
        await db.execute(
          `INSERT INTO work_metadata_directory_cache(chapter_id,novel_id,directory) VALUES($1,$2,$3)
          ON CONFLICT(chapter_id) DO UPDATE SET novel_id=excluded.novel_id,directory=excluded.directory`,
          [move.chapterId, canonical.id, move.targetRelativeDir],
        );
      }
      await db.execute(
        `INSERT OR IGNORE INTO novel_category(novel_id,category_id)
        SELECT $1,nc.category_id FROM novel_category nc JOIN novel n ON n.id=nc.novel_id
        WHERE n.plugin_id='local' OR n.is_local=1`, [canonical.id],
      );
      await db.execute("DELETE FROM novel WHERE (plugin_id='local' OR is_local=1) AND id<>$1", [canonical.id]);
      await flushWorkMetadata(db);
      await db.execute("COMMIT");
    });
  } catch (error) {
    const failures: unknown[] = [error];
    await db.execute("ROLLBACK").catch((rollbackError: unknown) => { failures.push(rollbackError); });
    if (preparation) await rollbackChapterStorageTransfer(preparation).catch((rollbackError: unknown) => { failures.push(rollbackError); });
    await initializeWorkMetadata(db, { rebuild: true }).catch((reloadError: unknown) => { failures.push(reloadError); });
    if (failures.length > 1) throw new AggregateError(failures, "Local chapter consolidation and recovery failed.");
    throw error;
  }
  if (preparation) {
    await finalizeChapterStorageTransfer(preparation).catch((error: unknown) => {
      // eslint-disable-next-line no-console -- Committed target files remain usable if old-folder cleanup fails.
      console.warn("[local-library] source cleanup failed", error);
    });
  }
}
