import type Database from "@tauri-apps/plugin-sql";
import { flushWorkMetadata } from "../db/work-metadata";
import { novelStorageRelativeDir } from "./chapter-storage-path";
import { finalizeChapterStorageTransfer, rollbackChapterStorageTransfer, removeChapterStorageDirectory,
  type ChapterStorageTransferEntry, type ChapterStorageTransferPreparation } from "./chapter-storage-transfer";
import { workMetadataOperation } from "./work-metadata";
import { canonicalMetadataValue, parseNovelMetadata, safeMetadataChild } from "./work-metadata/schema";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { chapterCompositionCatalog, type ChapterCompositionV1 } from "./chapter-composition";

const PREFIX = "norea-novel-merge-storage:";

interface MergeStorageWork { id: number; pluginId: string; sourceNovelId: string | null; path: string }
interface MergeStorageSnapshot extends MergeStorageWork {
  directory: string;
  metadataBody: string | null;
  nextMetadataBody: string | null;
  fingerprint: string | null;
}
export interface NovelMergeStorageJournal {
  version: 1;
  token: string;
  phase: "preparing" | "committed";
  source: MergeStorageSnapshot;
  target: MergeStorageSnapshot;
  entries: ChapterStorageTransferEntry[];
  cleanupDirectories: string[];
  preparation?: ChapterStorageTransferPreparation;
}

function parseJournal(payload: string): NovelMergeStorageJournal {
  const job = JSON.parse(payload) as NovelMergeStorageJournal;
  const validDirectory = (path: string, depth: number) => typeof path === "string" && path.split("/").length === depth &&
    path.startsWith("contents/") && path.split("/").every(safeMetadataChild);
  if (job.version !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(job.token) || !["preparing", "committed"].includes(job.phase) ||
      !job.source || !job.target || job.source.id === job.target.id || job.source.directory === job.target.directory ||
      [job.source, job.target].some(work => !Number.isSafeInteger(work.id) || work.id <= 0 ||
        typeof work.pluginId !== "string" || typeof work.sourceNovelId !== "string" || typeof work.path !== "string" ||
        !validDirectory(work.directory, 3) || (work.metadataBody !== null && typeof work.metadataBody !== "string") ||
        (work.nextMetadataBody !== null && typeof work.nextMetadataBody !== "string") ||
        (work.fingerprint !== null && typeof work.fingerprint !== "string")) ||
      !Array.isArray(job.entries) || !job.entries.length || job.entries.some(entry =>
        typeof entry.entryId !== "string" || !entry.entryId || !validDirectory(entry.sourceRelativeDir, 4) ||
        !validDirectory(entry.targetRelativeDir, 4) || !entry.sourceRelativeDir.startsWith(job.source.directory + "/") ||
        !entry.targetRelativeDir.startsWith(job.target.directory + "/")) ||
      !Array.isArray(job.cleanupDirectories) || job.cleanupDirectories.some(path => path !== job.source.directory)) {
    throw new Error("Work merge storage recovery journal is invalid. Existing files were retained.");
  }
  if (job.preparation && (job.preparation.token !== job.token || job.preparation.entries.length !== job.entries.length ||
      job.preparation.entries.some((entry, index) => entry.entryId !== job.entries[index]!.entryId ||
        entry.sourceRelativeDir !== job.entries[index]!.sourceRelativeDir || entry.targetRelativeDir !== job.entries[index]!.targetRelativeDir ||
        !["movedSource", "copiedSource", "keptTarget"].includes(entry.outcome)))) {
    throw new Error("Work merge storage receipt does not match its journal. Existing files were retained.");
  }
  return job;
}

async function saveJournal(db: Database, job: NovelMergeStorageJournal): Promise<void> {
  parseJournal(JSON.stringify(job));
  await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
    [PREFIX + job.token, JSON.stringify(job)]);
}

export async function createNovelMergeStorageJournal(
  db: Database, source: MergeStorageWork, target: MergeStorageWork, entries: ChapterStorageTransferEntry[], cleanupDirectories: string[],
  composition?: ChapterCompositionV1,
): Promise<NovelMergeStorageJournal> {
  await flushWorkMetadata(db);
  const snapshot = async (work: MergeStorageWork): Promise<MergeStorageSnapshot> => {
    const directory = novelStorageRelativeDir(work);
    const { body } = await workMetadataOperation({ operation: "read", path: directory + "/novel.json" });
    const [cached] = await db.select<{ fingerprint: string }[]>("SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id=$1", [work.id]);
    return { ...work, directory, metadataBody: body ?? null, nextMetadataBody: work.id === source.id ? null : body ?? null,
      fingerprint: cached?.fingerprint ?? null };
  };
  const job: NovelMergeStorageJournal = { version: 1, token: crypto.randomUUID(), phase: "preparing",
    source: await snapshot(source), target: await snapshot(target), entries,
    cleanupDirectories: [...new Set(cleanupDirectories.map(path => path.split("/").slice(0, 3).join("/")))],
  };
  if (composition) {
    if (!job.target.metadataBody) throw new Error("Target work metadata is missing before its folder move.");
    const metadata = parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(job.target.metadataBody))));
    job.target.nextMetadataBody = bytesToBase64(new TextEncoder().encode(JSON.stringify({ ...metadata,
      chapterComposition: composition, chapters: chapterCompositionCatalog(composition) })));
  }
  await saveJournal(db, job);
  return job;
}

export async function saveNovelMergeStoragePreparation(db: Database, job: NovelMergeStorageJournal, preparation: ChapterStorageTransferPreparation): Promise<void> {
  await saveJournal(db, { ...job, preparation });
}

export async function commitNovelMergeStorageInDb(db: Database, token: string): Promise<void> {
  const result = await db.execute("UPDATE content_sync_cache SET payload=json_set(payload,'$.phase','committed') WHERE cache_key=$1 AND json_extract(payload,'$.phase')='preparing'",
    [PREFIX + token]);
  if (result.rowsAffected !== 1) throw new Error("Work merge storage journal changed before commit.");
}

export async function finishNovelMergeStorageInDb(db: Database, token: string): Promise<void> {
  const [row] = await db.select<{ payload: string }[]>("SELECT payload FROM content_sync_cache WHERE cache_key=$1", [PREFIX + token]);
  if (!row) return;
  const job = parseJournal(row.payload);
  if (job.token !== token) throw new Error("Work merge storage journal token does not match its key.");
  for (const work of [job.source, job.target]) {
    const [current] = await db.select<MergeStorageWork[]>(
      "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE id=$1", [work.id]);
    if (job.phase === "committed" && work.id === job.source.id) {
      if (current) throw new Error("Committed work merge storage recovery still has its source work.");
    } else if (!current || current.pluginId !== work.pluginId || current.sourceNovelId !== work.sourceNovelId || current.path !== work.path) {
      throw new Error("Work merge storage recovery identity changed. Existing files were retained.");
    }
    if (job.phase === "preparing") {
      const [cached] = await db.select<{ fingerprint: string }[]>("SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id=$1", [work.id]);
      if ((cached?.fingerprint ?? null) !== work.fingerprint) throw new Error("Work merge metadata changed before recovery. Existing files were retained.");
      const { body } = await workMetadataOperation({ operation: "read", path: work.directory + "/novel.json" });
      const current = body ?? null;
      const sameMetadata = (expected: string | null) => {
        if (current === expected) return true;
        if (current === null || expected === null) return false;
        try {
          const parse = (value: string) => canonicalMetadataValue(parseNovelMetadata(JSON.parse(new TextDecoder().decode(base64ToBytes(value)))));
          return JSON.stringify(parse(current)) === JSON.stringify(parse(expected));
        } catch { return false; }
      };
      if (!sameMetadata(work.metadataBody) && !sameMetadata(work.nextMetadataBody)) {
        throw new Error("Work merge metadata changed outside the interrupted operation. Existing files were retained.");
      }
    }
  }
  if (job.phase === "committed") {
    if (!job.preparation) throw new Error("Committed work merge storage receipt is missing.");
    await finalizeChapterStorageTransfer(job.preparation);
    for (const directory of job.cleanupDirectories) await removeChapterStorageDirectory(directory);
  } else {
    await rollbackChapterStorageTransfer(job.preparation ?? { token: job.token, entries: job.entries.map(entry => ({
      ...entry, outcome: "movedSource", replacedTarget: true, contentFile: entry.targetRelativeDir + "/content.html", contentBytes: 0, mediaBytes: 0,
    })) });
    for (const work of [job.source, job.target]) {
      await workMetadataOperation(work.metadataBody === null
        ? { operation: "remove", path: work.directory + "/novel.json" }
        : { operation: "write", path: work.directory + "/novel.json", body: work.metadataBody });
    }
  }
  await db.execute("DELETE FROM content_sync_cache WHERE cache_key=$1", [PREFIX + token]);
}

/** Resolve interrupted moves before metadata scanning can mistake their folders for new downloads. */
export async function recoverNovelMergeStorageInDb(db: Database, workIds?: readonly number[]): Promise<void> {
  const rows = await db.select<{ payload: string }[]>("SELECT payload FROM content_sync_cache WHERE cache_key LIKE $1" +
    (workIds ? " AND (json_extract(payload,'$.source.id') IN (SELECT value FROM json_each($2)) OR json_extract(payload,'$.target.id') IN (SELECT value FROM json_each($2)))" : "") +
    " ORDER BY cache_key", workIds ? [PREFIX + "%", JSON.stringify(workIds)] : [PREFIX + "%"]);
  for (const row of rows) await finishNovelMergeStorageInDb(db, parseJournal(row.payload).token);
}
