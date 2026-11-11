import type { ChapterContentType } from "../lib/chapter-content";
import { withChapterDownloadSnapshotReads } from "../lib/chapter-download-writes";
import {
  parseStoredChapterPath,
  storedChapterDigest,
  storedChapterNumber,
  storedChapterPath,
} from "../lib/user-state/stored-chapter";
import type {
  UserStateChapterReference,
  UserStateValueMap,
  UserStateWorkReference,
} from "../lib/user-state/types";
import type { UserStateDb, UserStateIntent } from "./user-state-core";

interface StoredChapterCandidate {
  id: number;
  novelId: number;
  pluginId: string;
  sourceNovelId: string | null;
  novelPath: string;
  path: string;
  name: string;
  chapterNumber: string | null;
  position: number;
  contentType: ChapterContentType;
}

const CANDIDATE_COLUMNS = "c.id,c.novel_id AS novelId,n.plugin_id AS pluginId," +
  "n.source_novel_id AS sourceNovelId,n.path AS novelPath,c.path,c.name," +
  "c.chapter_number AS chapterNumber,c.position," +
  "COALESCE(c.stored_content_type,c.content_type) AS contentType";

async function hasComposition(db: UserStateDb, novelId: number): Promise<boolean> {
  const [row] = await db.select<{ present: number }[]>(
    "SELECT 1 AS present FROM novel_chapter_composition WHERE novel_id=$1 LIMIT 1",
    [novelId],
  );
  return !!row;
}

async function digestCandidate(candidate: StoredChapterCandidate): Promise<string | null> {
  return withChapterDownloadSnapshotReads(async hold => {
    if (!hold(candidate.id)) return null;
    try {
      const { inspectChapterPayloadInventory } = await import("../lib/chapter-content/storage-platform");
      const inventory = await inspectChapterPayloadInventory({
        novel: {
          id: candidate.novelId,
          pluginId: candidate.pluginId,
          sourceNovelId: candidate.sourceNovelId,
          path: candidate.novelPath,
        },
        chapter: {
          id: candidate.id,
          name: candidate.name,
          chapterNumber: candidate.chapterNumber,
          position: candidate.position,
          contentType: candidate.contentType,
        },
      });
      return await storedChapterDigest(inventory);
    } catch {
      return null;
    }
  });
}

async function localFolderCandidate(
  db: UserStateDb,
  work: UserStateWorkReference,
  chapter: UserStateChapterReference,
): Promise<StoredChapterCandidate | null> {
  if (!chapter.chapterPath.startsWith("norea-folder:") || !work.sourceNovelId || work.pluginId === "local") return null;
  const number = storedChapterNumber(chapter.chapterPath.slice("norea-folder:".length));
  if (number === null) return null;
  const rows = await db.select<StoredChapterCandidate[]>(
    "SELECT " + CANDIDATE_COLUMNS +
      " FROM chapter c JOIN novel n ON n.id=c.novel_id" +
      " WHERE n.plugin_id=$1 AND lower(n.source_novel_id)=lower($2) AND c.path=$3",
    [work.pluginId, work.sourceNovelId, chapter.chapterPath],
  );
  if (rows.length !== 1) return null;
  const candidate = rows[0]!;
  if (storedChapterNumber(candidate.chapterNumber) !== number || await hasComposition(db, candidate.novelId)) return null;
  return candidate;
}

export async function portableStoredChapterReferenceInDb(
  db: UserStateDb,
  work: UserStateWorkReference,
  chapter: UserStateChapterReference,
): Promise<UserStateChapterReference> {
  const candidate = await localFolderCandidate(db, work, chapter);
  if (!candidate) return chapter;
  const digest = await digestCandidate(candidate);
  const path = digest ? storedChapterPath(candidate.chapterNumber, digest) : null;
  return path ? { chapterPath: path, name: chapter.name ?? candidate.name } : chapter;
}

export async function portableStoredUserStateIntentInDb(
  db: UserStateDb,
  intent: UserStateIntent,
): Promise<UserStateIntent> {
  const { entity } = intent;
  if (entity.kind === "reading" || entity.kind === "bookmark") {
    const chapter = await portableStoredChapterReferenceInDb(db, entity.work, entity.chapter);
    return chapter.chapterPath === entity.chapter.chapterPath ? intent
      : { ...intent, entity: { ...entity, chapter } };
  }
  if (entity.kind === "resume") {
    const value = intent.value as UserStateValueMap["resume"];
    if (!value.chapter) return intent;
    const chapter = await portableStoredChapterReferenceInDb(db, entity.work, value.chapter);
    return chapter.chapterPath === value.chapter.chapterPath ? intent
      : { ...intent, value: { ...value, chapter } };
  }
  return intent;
}

export async function resolveStoredChapterReferenceInDb(
  db: UserStateDb,
  novelId: number,
  chapter: UserStateChapterReference,
): Promise<number | null> {
  const stored = parseStoredChapterPath(chapter.chapterPath);
  if (!stored || await hasComposition(db, novelId)) return null;

  let rows = await db.select<StoredChapterCandidate[]>(
    "SELECT " + CANDIDATE_COLUMNS +
      " FROM chapter c JOIN novel n ON n.id=c.novel_id" +
      " WHERE c.novel_id=$1 AND c.path=$2",
    [novelId, stored.folderPath],
  );
  if (!rows.length) {
    rows = await db.select<StoredChapterCandidate[]>(
      "SELECT " + CANDIDATE_COLUMNS +
        " FROM chapter c JOIN novel n ON n.id=c.novel_id" +
        " WHERE c.novel_id=$1 AND CAST(c.chapter_number AS REAL)=CAST($2 AS REAL)" +
        " ORDER BY c.id LIMIT 3",
      [novelId, stored.chapterNumber],
    );
    rows = rows.filter(row => storedChapterNumber(row.chapterNumber) === stored.chapterNumber);
  }
  if (rows.length !== 1) return null;
  const candidate = rows[0]!;
  if (storedChapterNumber(candidate.chapterNumber) !== stored.chapterNumber) return null;
  const digest = await digestCandidate(candidate);
  return digest === stored.sha256 ? candidate.id : null;
}
