import type Database from "@tauri-apps/plugin-sql";

interface WorkSourceIdentity {
  pluginId: string;
  path: string;
  name?: string;
}

interface NovelIdentityRow extends WorkSourceIdentity {
  id: number;
  name: string;
}

const FOLDER_PREFIX = "norea-folder:";

export async function findMatchingNovelIdentityInDb(db: Database, input: WorkSourceIdentity): Promise<NovelIdentityRow | null> {
  const rows = await db.select<NovelIdentityRow[]>(
    "SELECT id,plugin_id AS pluginId,path,name FROM novel WHERE plugin_id=$1 AND path=$2",
    [input.pluginId, input.path],
  );
  return rows[0] ?? null;
}

export async function reconcileImportedNovelIdentityInDb(
  db: Database,
  input: WorkSourceIdentity,
  chapters: readonly { path: string; chapterNumber?: string | null }[] = [],
): Promise<{ id: number; changed: boolean } | null> {
  const existing = await findMatchingNovelIdentityInDb(db, input);
  if (!existing) return null;
  const previous = await db.select<{ id: number; path: string; chapterNumber: string | null }[]>(
    "SELECT id,path,chapter_number AS chapterNumber FROM chapter WHERE novel_id=$1",
    [existing.id],
  );
  const paths = new Set(previous.map((chapter) => chapter.path));
  const chapterPathMap = new Map<string, string>();
  for (const chapter of previous) {
    if (!chapter.path.startsWith(FOLDER_PREFIX) || chapter.chapterNumber === null) continue;
    const number = Number(chapter.chapterNumber);
    if (!chapter.chapterNumber.trim() || !Number.isFinite(number)) continue;
    const matches = chapters.filter((item) => item.chapterNumber?.trim() && Number(item.chapterNumber) === number);
    if (!matches.length) continue;
    if (matches.length !== 1 || previous.filter((item) => item.chapterNumber?.trim() && Number(item.chapterNumber) === number).length !== 1 || paths.has(matches[0]!.path)) {
      throw new Error("Imported chapter identity is ambiguous; chapter state has been preserved.");
    }
    chapterPathMap.set(chapter.path, matches[0]!.path);
  }
  if (chapterPathMap.size === 0) return { id: existing.id, changed: false };
  for (const chapter of previous) {
    const path = chapterPathMap.get(chapter.path);
    if (path) await db.execute("UPDATE chapter SET path=$2 WHERE id=$1", [chapter.id, path]);
  }
  return { id: existing.id, changed: true };
}
