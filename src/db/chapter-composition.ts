import type Database from "@tauri-apps/plugin-sql";
import { assertChapterCompositionStorageOwnership, type ChapterCompositionPreparedCopy } from "../lib/chapter-composition-storage";
import { canonicalChapterNumber } from "../lib/source-chapter-renumber";
import {
  includedChapterCompositionEntries, parseChapterComposition,
  type ChapterCompositionV1, type ChapterSourceSnapshot,
} from "../lib/chapter-composition";

export async function getChapterComposition(
  db: Pick<Database, "select">, novelId: number,
): Promise<ChapterCompositionV1 | null> {
  const [row] = await db.select<{ payload: string }[]>(
    "SELECT payload FROM novel_chapter_composition WHERE novel_id=$1", [novelId],
  );
  return row ? parseChapterComposition(JSON.parse(row.payload)) : null;
}

/** Call in the same transaction as materialization and novel.json publication. */
export async function setChapterComposition(
  db: Pick<Database, "execute">, novelId: number, composition: ChapterCompositionV1 | null,
): Promise<void> {
  if (!composition) {
    await db.execute("DELETE FROM novel_chapter_composition WHERE novel_id=$1", [novelId]);
    return;
  }
  const payload = JSON.stringify(parseChapterComposition(composition));
  await db.execute(
    "INSERT INTO novel_chapter_composition(novel_id,payload) VALUES($1,$2) " +
    "ON CONFLICT(novel_id) DO UPDATE SET payload=excluded.payload WHERE payload IS NOT excluded.payload",
    [novelId, payload],
  );
}

/**
 * Apply the final list without moving physical files or resetting existing row IDs,
 * reading state, download state, or stored content metadata. The caller owns the transaction.
 */
export async function materializeChapterComposition(
  db: Pick<Database, "execute" | "select">, novelId: number, raw: ChapterCompositionV1,
  options: { preparedCopies?: readonly ChapterCompositionPreparedCopy[] } = {},
): Promise<void> {
  const composition = parseChapterComposition(raw);
  const [novel] = await db.select<{ pluginId: string; sourceNovelId: string | null; path: string }[]>(
    "SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE id=$1", [novelId],
  );
  if (!novel) throw new Error("Chapter composition: target work no longer exists");
  const previousComposition = await getChapterComposition(db, novelId);
  type ReadingState = { progress: number; bookmark: number; unread: number; readAt: number | null; excludedAt?: number | null };
  const existing = await db.select<(ReadingState & { path: string; chapterNumber: string | null; position: number })[]>(
    "SELECT path,chapter_number AS chapterNumber,position,progress,bookmark,unread,read_at AS readAt," +
    "(SELECT created_at FROM chapter_download_goal_exclusion WHERE chapter_id=chapter.id) AS excludedAt " +
    "FROM chapter WHERE novel_id=$1", [novelId],
  );
  const byPath = new Map(existing.map(row => [row.path, row]));
  const storageOwners = new Map<string, Set<string>>();
  const rememberStorageOwner = (number: string | null, path: string) => {
    if (number === null) return;
    const owners = storageOwners.get(number) ?? new Set<string>();
    owners.add(path);
    storageOwners.set(number, owners);
  };
  for (const chapter of existing) {
    rememberStorageOwner(canonicalChapterNumber(chapter.chapterNumber ?? chapter.position), chapter.path);
  }
  // Excluded entries still own their retained physical files.
  for (const entry of previousComposition?.entries ?? []) rememberStorageOwner(entry.storageChapterNumber, entry.path);
  for (const entry of composition.entries) {
    const current = byPath.get(entry.path);
    if (current?.chapterNumber != null && canonicalChapterNumber(current.chapterNumber) !== entry.storageChapterNumber) {
      throw new Error("Chapter composition: an existing storage chapter number cannot change");
    }
    if ([...(storageOwners.get(entry.storageChapterNumber) ?? [])].some(path => path !== entry.path)) {
      throw new Error("Chapter composition: the storage chapter number belongs to another chapter; existing files were retained");
    }
  }
  await assertChapterCompositionStorageOwnership({
    novel: { ...novel, id: novelId }, composition, previousComposition, existing, preparedCopies: options.preparedCopies,
  });
  const reading = await db.select<{
    path: string; progress: number; bookmark: number; unread: number; readAt: number | null;
  }[]>("SELECT chapter_path AS path,progress,bookmark,unread,read_at AS readAt " +
    "FROM work_metadata_reading_state WHERE plugin_id=$1 AND novel_path=$2", [novel.pluginId, novel.path]);
  const readingByPath = new Map(reading.map(row => [row.path, row]));
  const originKey = (source: ChapterSourceSnapshot) =>
    JSON.stringify([source.pluginId, source.novelId, source.chapterPath]);
  const previousPathsByOrigin = new Map<string, Set<string>>();
  for (const entry of previousComposition?.entries ?? []) {
    for (const source of entry.sources) {
      const key = originKey(source);
      const paths = previousPathsByOrigin.get(key) ?? new Set<string>();
      paths.add(entry.path);
      previousPathsByOrigin.set(key, paths);
    }
  }
  const entries = includedChapterCompositionEntries(composition);
  const inheritedStateByPath = new Map<string, ReadingState>();
  for (const entry of entries) {
    // Retained rows keep their current state, including a deliberate unread reset.
    if (byPath.has(entry.path)) continue;
    const paths = new Set([entry.path]);
    for (const source of entry.sources) {
      if (source.pluginId === novel.pluginId && source.novelId === novel.sourceNovelId) {
        paths.add(source.chapterPath);
      }
      // A previous composition may already have replaced the provider path with a
      // synthetic local path. Its origin links survive subsequent composition imports.
      for (const path of previousPathsByOrigin.get(originKey(source)) ?? []) paths.add(path);
    }
    const state: ReadingState = { progress: 0, bookmark: 0, unread: 1, readAt: null, excludedAt: null };
    for (const path of paths) {
      for (const previous of [byPath.get(path), readingByPath.get(path)]) {
        if (!previous) continue;
        state.progress = Math.max(state.progress, previous.progress);
        state.bookmark = state.bookmark || previous.bookmark ? 1 : 0;
        state.unread = state.unread && previous.unread ? 1 : 0;
        if (previous.readAt !== null) state.readAt = Math.max(state.readAt ?? 0, previous.readAt);
        const excludedAt = "excludedAt" in previous ? previous.excludedAt : null;
        if (typeof excludedAt === "number") state.excludedAt = Math.min(state.excludedAt ?? excludedAt, excludedAt);
      }
    }
    inheritedStateByPath.set(entry.path, state);
  }
  const now = Math.floor(Date.now() / 1000);
  // Bounded batches keep large compositions below SQLite's host parameter limit.
  for (let start = 0; start < entries.length; start += 50) {
    const params: unknown[] = [];
    const values = entries.slice(start, start + 50).map(entry => {
      const source = entry.sources[entry.primarySource];
      const state = inheritedStateByPath.get(entry.path) ?? readingByPath.get(entry.path);
      const offset = params.length;
      params.push(novelId, entry.path, entry.user.name ?? source.name, entry.storageChapterNumber,
        entry.user.order, source.page, source.contentType, source.releaseTime,
        state?.progress ?? 0, state?.bookmark ?? 0, state?.unread ?? 1, state?.readAt ?? null, now);
      return "(" + Array.from({ length: 13 }, (_, index) => "$" + (offset + index + 1)).join(",") + ")";
    });
    await db.execute(
      "INSERT INTO chapter(novel_id,path,name,chapter_number,position,page,content_type,release_time," +
      "progress,bookmark,unread,read_at,found_at) VALUES " + values.join(",") +
      " ON CONFLICT(novel_id,path) DO UPDATE SET name=excluded.name,chapter_number=excluded.chapter_number," +
      "position=excluded.position,page=excluded.page,content_type=excluded.content_type,release_time=excluded.release_time " +
      "WHERE chapter.name IS NOT excluded.name OR chapter.chapter_number IS NOT excluded.chapter_number " +
      "OR chapter.position IS NOT excluded.position OR chapter.page IS NOT excluded.page " +
      "OR chapter.content_type IS NOT excluded.content_type OR chapter.release_time IS NOT excluded.release_time",
      params,
    );
    // Copy only the automatic-download opt-out. A replacement edition must never
    // inherit the old edition's downloaded flag, stored format, bytes, or files.
    const exclusions = entries.slice(start, start + 50).flatMap(entry => {
      const excludedAt = inheritedStateByPath.get(entry.path)?.excludedAt;
      return excludedAt == null ? [] : [{ path: entry.path, excludedAt }];
    });
    if (exclusions.length) {
      const exclusionParams: unknown[] = [novelId];
      const exclusionValues = exclusions.map(({ path, excludedAt }) => {
        const offset = exclusionParams.length;
        exclusionParams.push(path, excludedAt);
        return "($" + (offset + 1) + ",$" + (offset + 2) + ")";
      });
      await db.execute(
        "WITH inherited(path,created_at) AS (VALUES " + exclusionValues.join(",") + ") " +
        "INSERT OR IGNORE INTO chapter_download_goal_exclusion(chapter_id,created_at) " +
        "SELECT c.id,i.created_at FROM chapter c JOIN inherited i ON i.path=c.path WHERE c.novel_id=$1",
        exclusionParams,
      );
    }
  }
  const includedPaths = new Set(entries.map(entry => entry.path));
  const removedPaths = existing.filter(chapter => !includedPaths.has(chapter.path)).map(chapter => chapter.path);
  for (let start = 0; start < removedPaths.length; start += 400) {
    const paths = removedPaths.slice(start, start + 400);
    const placeholders = paths.map((_, index) => "$" + (index + 2)).join(",");
    const params = [novelId, ...paths];
    await db.execute("DELETE FROM chapter_download_queue WHERE chapter_id IN " +
      "(SELECT id FROM chapter WHERE novel_id=$1 AND path IN (" + placeholders + "))", params);
    // The existing reading-state trigger keeps excluded chapters recoverable on re-inclusion.
    await db.execute("DELETE FROM chapter WHERE novel_id=$1 AND path IN (" + placeholders + ")", params);
  }
}
