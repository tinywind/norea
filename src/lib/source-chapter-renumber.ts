import type Database from "@tauri-apps/plugin-sql";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { MAX_NOVEL_COVER_BYTES } from "./work-metadata/schema";
import { persistWorkChapterDirectories } from "../db/work-metadata";
import { chapterStorageRelativeDir, novelStorageRelativeDir } from "./chapter-storage-path";
import {
  finalizeChapterStorageTransfer,
  rollbackChapterStorageTransfer,
  type ChapterStorageTransferPreparation,
} from "./chapter-storage-transfer";
import { isStorageId } from "./storage-id";
import { isTauriRuntime } from "./tauri-runtime";
import { workMetadataOperation } from "./work-metadata";
import type { ChapterItem } from "./plugins/types";

export const SOURCE_CHAPTER_RENUMBER_PREFIX = "norea-source-chapter-renumber:";
export const SERVER_CHAPTER_RENUMBER_PREFIX = "norea-content-chapter-number-reconciliation:";

export interface RenumberWork {
  id: number;
  pluginId: string;
  sourceNovelId: string;
  path: string;
}

export interface StoredRenumberChapter {
  id: number;
  path: string;
  chapterNumber: string | null;
  position: number;
  directory: string | null;
  isDownloaded: number;
}

export interface SourceChapterNumberChange {
  id: number;
  path: string;
  chapterNumber: string;
  nextPath: string;
  nextChapterNumber: string;
  sourceRelativeDir: string;
  targetRelativeDir: string;
  isDownloaded: boolean;
}

export interface ChapterNumberMapping {
  chapterPath: string;
  from: string;
  to: string;
}

export interface ServerChapterRenumberJob {
  version: 1;
  operationId: string;
  serverUrl: string;
  identity: { pluginId: string; novelId: string; novelPath: string };
  mappings: ChapterNumberMapping[];
  status: "pending" | "completed";
  createdAt: number;
  request?: {
    operationId: string;
    expectedWorkRevision: string;
    mappings: ChapterNumberMapping[];
  };
}

export interface ChapterRenumberCoverWrite { fileName: string; sha256: string }
export interface ChapterRenumberMetadataFile {
  path: string;
  body: string | null;
  sha256: string | null;
  nextSha256: string;
}

export interface SourceChapterRenumberJournal {
  version: 1 | 2;
  operationId: string;
  phase: "preparing" | "committed";
  work: RenumberWork;
  changes: SourceChapterNumberChange[];
  metadataBody: string | null;
  metadataFingerprint: string | null;
  serverUrl: string | null;
  preparation?: ChapterStorageTransferPreparation;
  metadataFiles?: ChapterRenumberMetadataFile[];
}

export function canonicalChapterNumber(value: unknown): string | null {
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^\d+(?:\.\d+)?$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && /^\d+(?:\.\d+)?$/.test(String(number)) ? String(number) : null;
}

function byKey<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  return groups;
}

function only<T>(rows: readonly T[] | undefined): T | undefined {
  if (rows && rows.length > 1) throw new Error("Source chapter identity is ambiguous; no chapter numbers were changed.");
  return rows?.[0];
}

/** Exact paths win. Numeric source IDs only recover old, out-of-range folder placeholders. */
export function planSourceChapterNumberChanges(
  work: RenumberWork,
  stored: readonly StoredRenumberChapter[],
  incoming: readonly Pick<ChapterItem, "path" | "chapterNumber" | "sourceChapterId">[],
): SourceChapterNumberChange[] {
  if (!incoming.length) return [];
  const paths = byKey(stored, chapter => chapter.path);
  const incomingPaths = byKey(incoming, chapter => chapter.path);
  const sourceIds = byKey(incoming.filter(chapter => canonicalChapterNumber(chapter.sourceChapterId) !== null),
    chapter => canonicalChapterNumber(chapter.sourceChapterId)!);
  const numbers = incoming.map(chapter => chapter.chapterNumber);
  const minimum = numbers.reduce((value, number) => Math.min(value, number), Infinity);
  const maximum = numbers.reduce((value, number) => Math.max(value, number), -Infinity);
  const matchedIds = new Set<number>();
  const changes: SourceChapterNumberChange[] = [];
  for (const chapter of incoming) {
    if ((incomingPaths.get(chapter.path)?.length ?? 0) !== 1) {
      throw new Error("Source chapter paths are not unique; no chapter numbers were changed.");
    }
    const nextNumber = canonicalChapterNumber(chapter.chapterNumber);
    if (nextNumber === null) throw new Error("Source chapter number is invalid.");
    let matched = only(paths.get(chapter.path));
    if (!matched) {
      const current = only(paths.get("norea-folder:" + nextNumber));
      if (current && canonicalChapterNumber(current.chapterNumber) === nextNumber) matched = current;
    }
    const sourceId = canonicalChapterNumber(chapter.sourceChapterId);
    if (!matched && sourceId !== null && (Number(sourceId) < minimum || Number(sourceId) > maximum)) {
      if (sourceIds.get(sourceId)?.length !== 1) {
        throw new Error("Source chapter IDs are ambiguous; no chapter numbers were changed.");
      }
      const legacy = only(paths.get("norea-folder:" + sourceId));
      if (legacy && canonicalChapterNumber(legacy.chapterNumber) === sourceId) matched = legacy;
    }
    if (!matched) continue;
    if (matchedIds.has(matched.id)) throw new Error("Several source chapters match one stored chapter.");
    matchedIds.add(matched.id);
    const previousNumber = canonicalChapterNumber(matched.chapterNumber);
    if (previousNumber === null || previousNumber === nextNumber) continue;
    if (stored.filter(row => canonicalChapterNumber(row.chapterNumber) === previousNumber).length !== 1) {
      throw new Error("A previous chapter number is ambiguous; no chapter numbers were changed.");
    }
    const sourceRelativeDir = chapterStorageRelativeDir(
      { pluginId: work.pluginId, sourceNovelId: work.sourceNovelId },
      { chapterNumber: previousNumber, position: matched.position },
    );
    if (matched.directory && matched.directory !== sourceRelativeDir) {
      throw new Error("A stored chapter directory does not match its number; no chapter numbers were changed.");
    }
    const targetRelativeDir = chapterStorageRelativeDir(
      { pluginId: work.pluginId, sourceNovelId: work.sourceNovelId },
      { chapterNumber: nextNumber, position: 1 },
    );
    changes.push({
      id: matched.id, path: matched.path, chapterNumber: previousNumber,
      nextPath: chapter.path, nextChapterNumber: nextNumber,
      sourceRelativeDir, targetRelativeDir, isDownloaded: Boolean(matched.isDownloaded),
    });
  }
  assertSourceChapterNumberChangesSupported(changes);
  const oldNumbers = new Set(changes.map(change => change.chapterNumber));
  const targets = new Set<string>();
  const oldPaths = new Set(changes.map(change => change.sourceRelativeDir));
  for (const change of changes) {
    if (oldNumbers.has(change.nextChapterNumber) || oldPaths.has(change.targetRelativeDir) || targets.has(change.nextChapterNumber)) {
      throw new Error("Chapter number changes overlap or form a cycle; no chapter numbers were changed.");
    }
    targets.add(change.nextChapterNumber);
    if (stored.some(chapter => chapter.id !== change.id &&
      (canonicalChapterNumber(chapter.chapterNumber) === change.nextChapterNumber || chapter.path === change.nextPath))) {
      throw new Error("A chapter number or path is already assigned; no chapter numbers were changed.");
    }
  }
  return changes;
}

/** Server proofs may bind a legacy folder only by its exact, unique old number. */
export function assertChapterNumberMappings(mappings: readonly ChapterNumberMapping[]): void {
  const from = new Set<string>();
  const to = new Set<string>();
  const paths = new Set<string>();
  for (const mapping of mappings) {
    if (!mapping || typeof mapping.chapterPath !== "string" ||
        typeof mapping.from !== "string" || typeof mapping.to !== "string" ||
        mapping.from === mapping.to || from.has(mapping.from) || to.has(mapping.to) ||
        paths.has(mapping.chapterPath)) {
      throw new Error("Server chapter number mapping is invalid or ambiguous.");
    }
    from.add(mapping.from); to.add(mapping.to); paths.add(mapping.chapterPath);
  }
  assertSourceChapterNumberChangesSupported(mappings.map(mapping => ({
    chapterNumber: mapping.from, nextChapterNumber: mapping.to, nextPath: mapping.chapterPath,
  })));
  if ([...from].some(number => to.has(number))) throw new Error("Server chapter number mapping overlaps.");
}

export function planServerChapterNumberChanges(
  work: RenumberWork,
  stored: readonly StoredRenumberChapter[],
  mappings: readonly ChapterNumberMapping[],
): SourceChapterNumberChange[] {
  assertChapterNumberMappings(mappings);
  const byFrom = new Map(mappings.map(mapping => [mapping.from, mapping]));
  const byPath = new Map(mappings.map(mapping => [mapping.chapterPath, mapping]));
  const original = new Map(stored.map(row => [row.id, row]));
  const translated = stored.map(row => {
    const number = canonicalChapterNumber(row.chapterNumber);
    const pathMapping = byPath.get(row.path);
    if (pathMapping && number !== pathMapping.from && number !== pathMapping.to) {
      throw new Error("Server chapter mapping does not match the stored chapter number.");
    }
    const mapping = number === null ? undefined : byFrom.get(number);
    if (!mapping) return row;
    if (row.path !== mapping.chapterPath && row.path !== "norea-folder:" + mapping.from) {
      throw new Error("Server chapter mapping conflicts with a stored source path.");
    }
    return { ...row, path: mapping.chapterPath };
  });
  return planSourceChapterNumberChanges(work, translated, mappings.map(mapping => ({
    path: mapping.chapterPath, chapterNumber: Number(mapping.to), sourceChapterId: mapping.from,
  }))).map(change => ({ ...change, path: original.get(change.id)!.path }));
}

export function assertSourceChapterNumberChangesSupported(changes: readonly Pick<SourceChapterNumberChange, "chapterNumber" | "nextChapterNumber" | "nextPath">[]): void {
  if (changes.length > 10_000) throw new Error("Chapter number reconciliation supports at most 10000 mappings.");
  for (const change of changes) {
    if (![change.chapterNumber, change.nextChapterNumber].every(value => canonicalChapterNumber(value) === value &&
        Number.isSafeInteger(Number(value)) && Number(value) > 0)) {
      throw new Error("Chapter number reconciliation requires positive safe integer numbers.");
    }
    if (!change.nextPath.trim() || change.nextPath.length > 4096 || change.nextPath.startsWith("norea-folder:")) {
      throw new Error("Chapter number reconciliation requires an actual source path of at most 4096 characters.");
    }
  }
}

export async function readRenumberChapters(db: Pick<Database, "select">, novelId: number): Promise<StoredRenumberChapter[]> {
  return db.select<StoredRenumberChapter[]>(
    "SELECT c.id,c.path,c.chapter_number AS chapterNumber,c.position,c.is_downloaded AS isDownloaded,d.directory " +
    "FROM chapter c LEFT JOIN work_metadata_directory_cache d ON d.chapter_id=c.id WHERE c.novel_id=$1 ORDER BY c.id",
    [novelId],
  );
}

export function renumberJournalKey(operationId: string): string {
  return SOURCE_CHAPTER_RENUMBER_PREFIX + operationId;
}

function metadataPath(work: RenumberWork): string {
  return novelStorageRelativeDir({ pluginId: work.pluginId, sourceNovelId: work.sourceNovelId }) + "/novel.json";
}

const COVER_FILE_NAME = /^cover\.(?:avif|bmp|gif|img|jpe?g|png|svg|webp)$/i;
const SHA256 = /^[a-f0-9]{64}$/;

async function bodySha256(body: string): Promise<string> {
  const bytes = base64ToBytes(body);
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateMetadataFiles(job: SourceChapterRenumberJournal): void {
  if (job.version === 1 && job.metadataFiles !== undefined ||
      job.version === 2 && (!Array.isArray(job.metadataFiles) || job.metadataFiles.length !== 1)) {
    throw new Error("Stored chapter reconciliation metadata backup is invalid.");
  }
  const root = novelStorageRelativeDir({ pluginId: job.work.pluginId, sourceNovelId: job.work.sourceNovelId });
  for (const file of job.metadataFiles ?? []) {
    const name = typeof file?.path === "string" ? file.path.slice(root.length + 1) : "";
    if (!file || file.path !== root + "/" + name || !COVER_FILE_NAME.test(name) ||
        !SHA256.test(file.nextSha256) ||
        file.body === null && file.sha256 !== null ||
        file.body !== null && (typeof file.body !== "string" || typeof file.sha256 !== "string" || !SHA256.test(file.sha256))) {
      throw new Error("Stored chapter reconciliation cover identity is invalid.");
    }
    if (file.body !== null) {
      if (file.body.length > Math.ceil(MAX_NOVEL_COVER_BYTES / 3) * 4) throw new Error("Stored cover backup exceeds the byte limit.");
      try {
        const bytes = base64ToBytes(file.body);
        if (bytes.length > MAX_NOVEL_COVER_BYTES || bytesToBase64(bytes) !== file.body) throw new Error("Invalid encoding");
      } catch {
        throw new Error("Stored cover backup encoding is invalid.");
      }
    }
  }
}

async function inspectMetadataFiles(job: SourceChapterRenumberJournal, mode: "original" | "rollback" | "committed") {
  validateMetadataFiles(job);
  const checked: { file: ChapterRenumberMetadataFile; currentSha256: string | null }[] = [];
  if (!isTauriRuntime()) return checked;
  for (const file of job.metadataFiles ?? []) {
    if (file.body !== null && await bodySha256(file.body) !== file.sha256) {
      throw new Error("Stored cover backup does not match its digest. Existing files were retained.");
    }
    const current = await workMetadataOperation({ operation: "read", path: file.path });
    if (current.body != null && current.body.length > Math.ceil(MAX_NOVEL_COVER_BYTES / 3) * 4) throw new Error("Current cover exceeds the recovery byte limit. Existing files were retained.");
    const currentSha256 = current.body == null ? null : await bodySha256(current.body);
    const accepted = mode === "original" ? currentSha256 === file.sha256
      : mode === "committed" ? currentSha256 === file.nextSha256
      : currentSha256 === file.sha256 || currentSha256 === file.nextSha256;
    if (!accepted) throw new Error("The cover changed outside chapter reconciliation. Existing files and the recovery backup were retained.");
    checked.push({ file, currentSha256 });
  }
  return checked;
}

export async function assertSourceChapterRenumberMetadataUnchanged(job: SourceChapterRenumberJournal): Promise<void> {
  await inspectMetadataFiles(job, "original");
}

/** Guard the ordinary transaction rollback as well as durable restart recovery. */
export async function assertSourceChapterRenumberMetadataRecoverable(job: SourceChapterRenumberJournal): Promise<void> {
  await inspectMetadataFiles(job, "rollback");
}

export function parseSourceChapterRenumberJournal(payload: string): SourceChapterRenumberJournal {
  const job = JSON.parse(payload) as SourceChapterRenumberJournal;
  if (![1, 2].includes(job.version) || typeof job.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(job.operationId) ||
      !["preparing", "committed"].includes(job.phase) || !job.work || !Number.isSafeInteger(job.work.id) || job.work.id <= 0 ||
      !isStorageId(job.work.pluginId) || !isStorageId(job.work.sourceNovelId) || typeof job.work.path !== "string" || !job.work.path ||
      !Array.isArray(job.changes) || !job.changes.length ||
      (job.metadataBody !== null && typeof job.metadataBody !== "string") ||
      (job.metadataFingerprint !== null && typeof job.metadataFingerprint !== "string") ||
      (job.serverUrl !== null && typeof job.serverUrl !== "string")) {
    throw new Error("Stored chapter number reconciliation is invalid; existing files were retained.");
  }
  validateMetadataFiles(job);
  const ids = new Set<number>();
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const change of job.changes) {
    const from = canonicalChapterNumber(change.chapterNumber);
    const to = canonicalChapterNumber(change.nextChapterNumber);
    const root = novelStorageRelativeDir({ pluginId: job.work.pluginId, sourceNovelId: job.work.sourceNovelId });
    if (!Number.isSafeInteger(change.id) || change.id <= 0 || ids.has(change.id) ||
        typeof change.path !== "string" || !change.path || typeof change.nextPath !== "string" || !change.nextPath ||
        from === null || to === null || from === to || from !== change.chapterNumber || to !== change.nextChapterNumber ||
        change.sourceRelativeDir !== root + "/" + from || change.targetRelativeDir !== root + "/" + to ||
        typeof change.isDownloaded !== "boolean" || sources.has(change.sourceRelativeDir) || targets.has(change.targetRelativeDir)) {
      throw new Error("Stored chapter number mapping is invalid; existing files were retained.");
    }
    ids.add(change.id); sources.add(change.sourceRelativeDir); targets.add(change.targetRelativeDir);
  }
  assertSourceChapterNumberChangesSupported(job.changes);
  if ([...targets].some(target => sources.has(target))) throw new Error("Stored chapter number mapping overlaps.");
  if (job.preparation) validateRenumberPreparation(job, job.preparation);
  if (job.phase === "committed" && isTauriRuntime() && !job.preparation) {
    throw new Error("Committed chapter number reconciliation has no storage receipt.");
  }
  return job;
}

export function validateRenumberPreparation(job: SourceChapterRenumberJournal, preparation: ChapterStorageTransferPreparation): void {
  if (preparation.token !== job.operationId || preparation.entries.length !== job.changes.length) {
    throw new Error("Chapter number storage receipt does not match its journal.");
  }
  const changes = new Map(job.changes.map(change => [String(change.id), change]));
  const seen = new Set<string>();
  for (const entry of preparation.entries) {
    const change = changes.get(entry.entryId);
    if (!change || seen.has(entry.entryId) || entry.sourceRelativeDir !== change.sourceRelativeDir ||
        entry.targetRelativeDir !== change.targetRelativeDir || entry.replacedTarget ||
        (entry.outcome !== "copiedSource" && entry.outcome !== "sourceNotDownloaded") ||
        (entry.outcome === "sourceNotDownloaded" && change.isDownloaded)) {
      throw new Error("Chapter number storage transfer could not preserve every existing download.");
    }
    seen.add(entry.entryId);
  }
}

export function pendingRenumberRollback(job: SourceChapterRenumberJournal): ChapterStorageTransferPreparation {
  return job.preparation ?? {
    token: job.operationId,
    entries: job.changes.map(change => ({
      entryId: String(change.id), sourceRelativeDir: change.sourceRelativeDir, targetRelativeDir: change.targetRelativeDir,
      outcome: "copiedSource", replacedTarget: false, contentFile: change.targetRelativeDir + "/content.html",
      contentBytes: 0, mediaBytes: 0,
    })),
  };
}

export async function saveSourceChapterRenumberJournal(db: Pick<Database, "execute">, job: SourceChapterRenumberJournal): Promise<void> {
  await db.execute(
    "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
    [renumberJournalKey(job.operationId), JSON.stringify(job)],
  );
}

export async function readSourceChapterRenumberJournal(db: Pick<Database, "select">, operationId: string): Promise<SourceChapterRenumberJournal | null> {
  const [row] = await db.select<{ payload: string }[]>("SELECT payload FROM content_sync_cache WHERE cache_key=$1", [renumberJournalKey(operationId)]);
  return row ? parseSourceChapterRenumberJournal(row.payload) : null;
}

export async function createSourceChapterRenumberJournal(
  db: Database,
  work: RenumberWork,
  changes: SourceChapterNumberChange[],
  serverUrl: string | null,
  coverWrites: readonly ChapterRenumberCoverWrite[] = [],
): Promise<SourceChapterRenumberJournal> {
  assertSourceChapterNumberChangesSupported(changes);
  if (coverWrites.length > 1) throw new Error("Chapter reconciliation supports one incoming cover target.");
  const root = novelStorageRelativeDir({ pluginId: work.pluginId, sourceNovelId: work.sourceNovelId });
  const metadataFiles: ChapterRenumberMetadataFile[] = [];
  for (const write of coverWrites) {
    if (!COVER_FILE_NAME.test(write.fileName) || !SHA256.test(write.sha256)) throw new Error("Incoming chapter reconciliation cover is invalid.");
    const path = root + "/" + write.fileName;
    const snapshot = isTauriRuntime() ? await workMetadataOperation({ operation: "read", path }) : { body: null };
    const body = snapshot.body ?? null;
    if (body !== null && body.length > Math.ceil(MAX_NOVEL_COVER_BYTES / 3) * 4) throw new Error("Stored cover backup exceeds the byte limit.");
    metadataFiles.push({ path, body, sha256: body === null ? null : await bodySha256(body), nextSha256: write.sha256 });
  }
  const metadata = isTauriRuntime() ? await workMetadataOperation({ operation: "read", path: metadataPath(work) }) : { body: null };
  const [cached] = await db.select<{ fingerprint: string }[]>("SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id=$1", [work.id]);
  const job: SourceChapterRenumberJournal = {
    version: metadataFiles.length ? 2 : 1, operationId: crypto.randomUUID(), phase: "preparing", work, changes,
    metadataBody: metadata.body ?? null, metadataFingerprint: cached?.fingerprint ?? null, serverUrl,
    ...(metadataFiles.length ? { metadataFiles } : {}),
  };
  validateMetadataFiles(job);
  await saveSourceChapterRenumberJournal(db, job);
  return job;
}

export async function applySourceChapterNumberChangesInDb(db: Database, novelId: number, job: SourceChapterRenumberJournal): Promise<void> {
  if (job.work.id !== novelId || job.phase !== "preparing") throw new Error("Chapter number reconciliation no longer matches this work.");
  const current = await readRenumberChapters(db, novelId);
  for (const change of job.changes) {
    const chapter = current.find(row => row.id === change.id);
    if (!chapter || chapter.path !== change.path || canonicalChapterNumber(chapter.chapterNumber) !== change.chapterNumber ||
        current.some(row => row.id !== change.id &&
          (row.path === change.nextPath || canonicalChapterNumber(row.chapterNumber) === change.nextChapterNumber))) {
      throw new Error("A chapter changed while its number was being reconciled; existing files were retained.");
    }
  }
  for (const change of job.changes) {
    await db.execute("UPDATE chapter SET path=$1,chapter_number=$2,updated_at=unixepoch() WHERE id=$3 AND novel_id=$4",
      [change.nextPath, change.nextChapterNumber, change.id, novelId]);
  }
  const changed = new Map(job.changes.map(change => [change.id, change.targetRelativeDir]));
  const directories = current.flatMap(chapter => {
    const directory = changed.get(chapter.id) ?? chapter.directory;
    return directory ? [{ id: chapter.id, directory }] : [];
  });
  await persistWorkChapterDirectories(db, novelId, directories);
  const rows = await db.select<{ key: string; payload: string }[]>(
    "SELECT cache_key AS key,payload FROM content_sync_cache WHERE cache_key LIKE 'norea-content-deletions:%'",
  );
  const replacements = new Map(job.changes.map(change => [change.chapterNumber, change.nextChapterNumber]));
  for (const row of rows) {
    const exclusions = JSON.parse(row.payload) as string[];
    if (!Array.isArray(exclusions)) throw new Error("Stored chapter deletion exclusions are invalid.");
    let changedExclusions = false;
    const next = exclusions.map(value => {
      const key: unknown = JSON.parse(value);
      if (!Array.isArray(key) || key.length !== 3 || key[0] !== job.work.pluginId || key[1] !== job.work.sourceNovelId ||
          !Array.isArray(key[2]) || key[2][0] !== "number") return value;
      const number = canonicalChapterNumber(key[2][1]);
      const replacement = number === null ? undefined : replacements.get(number);
      if (replacement === undefined) return value;
      changedExclusions = true;
      return JSON.stringify([key[0], key[1], ["number", Number(replacement)]]);
    });
    if (changedExclusions) await db.execute("UPDATE content_sync_cache SET payload=$1 WHERE cache_key=$2",
      [JSON.stringify([...new Set(next)]), row.key]);
  }
}

export async function commitSourceChapterRenumberInDb(db: Database, job: SourceChapterRenumberJournal): Promise<void> {
  await saveSourceChapterRenumberJournal(db, { ...job, phase: "committed" });
  if (job.serverUrl) {
    const remote: ServerChapterRenumberJob = {
      version: 1, operationId: job.operationId, serverUrl: job.serverUrl,
      identity: { pluginId: job.work.pluginId, novelId: job.work.sourceNovelId, novelPath: job.work.path },
      mappings: job.changes.map(change => ({ chapterPath: change.nextPath, from: change.chapterNumber, to: change.nextChapterNumber })),
      status: "pending", createdAt: Date.now(),
    };
    await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2)",
      [SERVER_CHAPTER_RENUMBER_PREFIX + job.operationId, JSON.stringify(remote)]);
  }
}

/** Runs before storage scanning. The committed database phase decides which copy is authoritative. */
export async function recoverSourceChapterRenumbersInDb(db: Database): Promise<void> {
  const rows = await db.select<{ payload: string }[]>(
    "SELECT payload FROM content_sync_cache WHERE cache_key LIKE $1 ORDER BY cache_key", [SOURCE_CHAPTER_RENUMBER_PREFIX + "%"],
  );
  for (const row of rows) await finishSourceChapterRenumberInDb(db, parseSourceChapterRenumberJournal(row.payload));
}

export async function finishSourceChapterRenumberInDb(db: Database, job: SourceChapterRenumberJournal): Promise<void> {
  const [work] = await db.select<RenumberWork[]>(
    "SELECT id,plugin_id AS pluginId,source_novel_id AS sourceNovelId,path FROM novel WHERE id=$1", [job.work.id]);
  const rows = await readRenumberChapters(db, job.work.id);
  const committed = job.phase === "committed";
  if (!work || work.pluginId !== job.work.pluginId || work.sourceNovelId !== job.work.sourceNovelId || work.path !== job.work.path ||
      job.changes.some(change => {
        const row = rows.find(current => current.id === change.id);
        const expectedNumber = committed ? change.nextChapterNumber : change.chapterNumber;
        const expectedDirectory = committed ? change.targetRelativeDir : change.sourceRelativeDir;
        return !row || row.path !== (committed ? change.nextPath : change.path) ||
          canonicalChapterNumber(row.chapterNumber) !== expectedNumber ||
          (committed ? row.directory !== expectedDirectory : row.directory !== null && row.directory !== expectedDirectory);
      })) {
    throw new Error("Chapter number recovery does not match the current database. Existing files were retained.");
  }
  if (!committed) {
    const [cached] = await db.select<{ fingerprint: string }[]>(
      "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id=$1", [job.work.id]);
    if ((cached?.fingerprint ?? null) !== job.metadataFingerprint) {
      throw new Error("Work metadata changed after chapter reconciliation was prepared. Existing files were retained.");
    }
  }
  const metadataFiles = await inspectMetadataFiles(job, committed ? "committed" : "rollback");
  if (isTauriRuntime()) {
    if (job.phase === "committed") await finalizeChapterStorageTransfer(job.preparation!);
    else {
      await rollbackChapterStorageTransfer(pendingRenumberRollback(job));
      for (const { file, currentSha256 } of metadataFiles) {
        if (currentSha256 === file.sha256) continue;
        await workMetadataOperation(file.body === null
          ? { operation: "remove", path: file.path }
          : { operation: "write", path: file.path, body: file.body });
      }
      await workMetadataOperation(job.metadataBody === null
        ? { operation: "remove", path: metadataPath(job.work) }
        : { operation: "write", path: metadataPath(job.work), body: job.metadataBody });
    }
  }
  await db.execute("DELETE FROM content_sync_cache WHERE cache_key=$1", [renumberJournalKey(job.operationId)]);
}
