import type { ChapterContentType } from "../../lib/chapter-content";
import { getChapterComposition } from "../chapter-composition";
import type Database from "@tauri-apps/plugin-sql";
import { getDb, runDatabaseTransaction } from "../client";
import { isChapterPayloadInventory, type ChapterPayloadInventory } from "../../lib/chapter-content/inventory";
import type { MigrationWorkIdentity, NovelMigrationTargetMetadata, PendingNovelMigration, WorkMigrationSnapshot } from "../../lib/content-sync/novel-migration-types";
import { sqliteBoolean } from "../sqlite-value";
import { canonicalMetadataValue, parseNovelMetadata, type NovelMetadataV1 } from "../../lib/work-metadata/schema";
import type { PackageManifest } from "../../lib/content-sync/native";
import type { ServerChapterSummary } from "../../lib/content-sync/chapters";
import { LOCAL_PLUGIN_ID } from "../../lib/plugins/types";
import { reconcileImportedNovelIdentityInDb } from "./novel-identity";

function assertServerChapterNumberMatches(current: string | null | undefined, incoming: string | null | undefined): void {
  const number = (value: string | null | undefined) => value?.trim() && Number.isFinite(Number(value)) ? String(Number(value)) : null;
  const from = number(current);
  const to = number(incoming);
  if (from !== null && to !== null && from !== to) {
    throw new Error("Synchronize the corrected work metadata before importing its chapters. Existing files were retained.");
  }
}

export async function cacheServerChapters(novelId: number, chapters: readonly ServerChapterSummary[], signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const changed = await runDatabaseTransaction(async db => {
    if (signal?.aborted) return false;
    const [novel] = await db.select<{ pluginId: string }[]>(
      "SELECT plugin_id AS pluginId FROM novel WHERE id=$1", [novelId]);
    const existing = await db.select<{ path: string; chapterNumber: string | null }[]>(
      "SELECT path,chapter_number AS chapterNumber FROM chapter WHERE novel_id=$1", [novelId]);
    if (signal?.aborted) return false;
    const paths = new Set(existing.map(chapter => chapter.path));
    const byPath = new Map(existing.map(chapter => [chapter.path, chapter.chapterNumber]));
    const numbers = new Map<string, string[]>();
    for (const chapter of existing) {
      if (!chapter.chapterNumber?.trim() || !Number.isFinite(Number(chapter.chapterNumber))) continue;
      const number = String(Number(chapter.chapterNumber));
      numbers.set(number, [...(numbers.get(number) ?? []), chapter.path]);
    }
    const composition = await getChapterComposition(db, novelId);
    const included = composition ? new Map(composition.entries.filter(entry => entry.user.included).map(entry => [entry.path, entry])) : null;
    const incoming: (Omit<ServerChapterSummary, "contentType"> & { contentType: ChapterContentType })[] = [];
    for (const chapter of chapters) {
      if (included && !included.has(chapter.chapterPath)) continue;
      if (paths.has(chapter.chapterPath)) {
        assertServerChapterNumberMatches(byPath.get(chapter.chapterPath), chapter.chapterNumber);
        continue;
      }
      const number = novel?.pluginId !== LOCAL_PLUGIN_ID && chapter.chapterNumber?.trim() && Number.isFinite(Number(chapter.chapterNumber)) ? String(Number(chapter.chapterNumber)) : null;
      const matches = number === null ? [] : numbers.get(number) ?? [];
      if (matches.length) {
        if (matches.length > 1) throw new Error("Server chapter number matches multiple local chapters.");
        continue;
      }
      const entry = included?.get(chapter.chapterPath);
      if (entry) {
        assertServerChapterNumberMatches(entry.storageChapterNumber, chapter.chapterNumber);
        const source = entry.sources[entry.primarySource];
        incoming.push({ ...chapter, name: entry.user.name ?? source.name, position: entry.user.order, page: source.page, contentType: source.contentType });
      } else incoming.push(chapter);
      paths.add(chapter.chapterPath);
      if (number !== null) numbers.set(number, [chapter.chapterPath]);
    }
    let inserted = false;
    for (let offset = 0; offset < incoming.length; offset += 100) {
      if (signal?.aborted) break;
      const batch = incoming.slice(offset, offset + 100);
      const result = await db.execute(`INSERT INTO chapter(novel_id,path,name,chapter_number,position,page,content_type)
        VALUES ${batch.map((_, index) => `(${Array.from({ length: 7 }, (_, column) => `$${index * 7 + column + 1}`).join(",")})`).join(",")}
        ON CONFLICT(novel_id,path) DO NOTHING`, batch.flatMap(chapter => [novelId, chapter.chapterPath, chapter.name, chapter.chapterNumber ?? null, chapter.position, chapter.page, chapter.contentType]));
      inserted ||= result.rowsAffected > 0;
    }
    return inserted;
  }, true);
  // Report navigation cancellation after committing already cached chapters.
  signal?.throwIfAborted();
  return changed;
}

export async function readContentSyncCache(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ payload: string }[]>("SELECT payload FROM content_sync_cache WHERE cache_key=$1", [key]);
  return rows[0]?.payload ?? null;
}

export async function writeContentSyncCache(key: string, payload: string): Promise<void> {
  const db = await getDb();
  await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload", [key, payload]);
}

export async function clearServerChapterDownloadProof(chapterId: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM content_sync_cache WHERE cache_key=$1", [`norea-content-chapter-source:${chapterId}`]);
}

export async function rememberServerChapterDownload(row: ContentSyncChapter, serverUrl: string, fingerprint: string): Promise<void> {
  await writeContentSyncCache(`norea-content-chapter-source:${row.chapterId}`, JSON.stringify({
    chapterId: row.chapterId, novelId: row.novelId, pluginId: row.pluginId, sourceNovelId: row.sourceNovelId,
    novelPath: row.novelPath, chapterPath: row.chapterPath, chapterNumber: row.chapterNumber,
    position: row.position, serverUrl, fingerprint,
  }));
}

export interface ContentSyncChapter {
  chapterId: number;
  novelId: number;
  pluginId: string;
  novelPath: string;
  sourceNovelId: string | null;
  chapterPath: string;
  novelName: string;
  author: string | null;
  summary: string | null;
  isLocal: boolean;
  chapterName: string;
  chapterNumber: string | null;
  position: number;
  page: string;
  contentType: PackageManifest["chapter"]["contentType"];
  isDownloaded: boolean;
  mediaRepairNeeded: boolean;
  isDownloadQueued: boolean;
  contentBytes: number;
  mediaBytes: number;
}

export async function listContentSyncChapters(identities?: string[], downloadedOnly = false): Promise<ContentSyncChapter[]> {
  return selectContentSyncChapters(identities, downloadedOnly, false);
}

export async function listContentSyncWorkChapters(workIdentities: string[]): Promise<ContentSyncChapter[]> {
  return selectContentSyncChapters(workIdentities, true, true);
}

async function selectContentSyncChapters(identities: string[] | undefined, downloadedOnly: boolean, matchWorks: boolean): Promise<ContentSyncChapter[]> {
  if (identities?.length === 0) return [];
  if (identities && identities.length > 100) {
    const rows: ContentSyncChapter[] = [];
    for (let offset = 0; offset < identities.length; offset += 100) rows.push(...await selectContentSyncChapters(identities.slice(offset, offset + 100), downloadedOnly, matchWorks));
    return rows;
  }
  const db = await getDb();
  const targets = identities?.flatMap((identity) => JSON.parse(identity) as string[]);
  const columns = matchWorks ? ["plugin_id", "novel_path"] : ["plugin_id", "novel_path", "chapter_path"];
  const prefix = identities ? `WITH targets(${columns.join(",")}) AS (VALUES ${identities.map((_, i) => `(${columns.map((_, column) => `$${i * columns.length + column + 1}`).join(",")})`).join(",")})` : "";
  const from = identities ? `targets t JOIN novel n ON n.plugin_id=t.plugin_id AND n.path=t.novel_path JOIN chapter c ON c.novel_id=n.id${matchWorks ? "" : " AND c.path=t.chapter_path"}` : "chapter c JOIN novel n ON n.id=c.novel_id";
  const rows = await db.select<ContentSyncChapter[]>(`${prefix} SELECT
    c.id AS chapterId, n.id AS novelId, n.plugin_id AS pluginId, n.path AS novelPath, n.source_novel_id AS sourceNovelId,
    c.path AS chapterPath, n.name AS novelName, n.author, n.summary,
    n.is_local AS isLocal,
    c.name AS chapterName, c.chapter_number AS chapterNumber, c.position, c.page,
    COALESCE(c.stored_content_type,c.content_type) AS contentType,
    c.is_downloaded AS isDownloaded, c.media_repair_needed AS mediaRepairNeeded,
    c.content_bytes AS contentBytes, c.media_bytes AS mediaBytes,
    EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id=c.id) AS isDownloadQueued
    FROM ${from} ${downloadedOnly ? "WHERE (c.is_downloaded=1 OR c.content_bytes>0)" : ""} ORDER BY n.id,c.position,c.id`, targets);
  return rows.map((row) => ({ ...row, isLocal: sqliteBoolean(row.isLocal),
    isDownloaded: sqliteBoolean(row.isDownloaded), mediaRepairNeeded: sqliteBoolean(row.mediaRepairNeeded),
    isDownloadQueued: sqliteBoolean(row.isDownloadQueued) }));
}

export async function canUploadContentChapter(chapterId: number): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ ready: boolean }[]>(`SELECT EXISTS(
    SELECT 1 FROM chapter c WHERE c.id=$1 AND (c.is_downloaded=1 OR c.content_bytes>0)
    AND NOT EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id=c.id)
  ) AS ready`, [chapterId]);
  return sqliteBoolean(rows[0]?.ready);
}

export async function importContentMetadata(manifest: PackageManifest, serverUrl?: string): Promise<{ novelId: number; chapterId: number }> {
  return runDatabaseTransaction(async (db) => {
    const { identity, chapter } = manifest;
    if (serverUrl && await isNovelMigrationSourceHeldInDb(db, serverUrl, identity)) {
      throw new Error("The original work is held while its server migration completes.");
    }
    const novels = await db.select<{ id: number; sourceNovelId: string | null }[]>("SELECT id,source_novel_id AS sourceNovelId FROM novel WHERE plugin_id=$1 AND path=$2", [identity.pluginId, identity.novelPath]);
    if (!novels.length) throw new Error("Install the work metadata before downloading its chapters.");
    if (novels[0]!.sourceNovelId !== identity.novelId) throw new Error("Server chapter novel ID does not match the installed work.");
    const novelId = novels[0]!.id;
    const composition = await getChapterComposition(db, novelId);
    const compositionEntry = composition?.entries.find(entry => entry.path === identity.chapterPath);
    if (composition && (!compositionEntry?.user.included || compositionEntry.storageChapterNumber !== chapter.chapterNumber)) {
      throw new Error("The server chapter is excluded from the final chapter list or has a different storage identity.");
    }
    const [currentChapter] = await db.select<{ chapterNumber: string | null }[]>(
      "SELECT chapter_number AS chapterNumber FROM chapter WHERE novel_id=$1 AND path=$2", [novelId, identity.chapterPath]);
    if (currentChapter) assertServerChapterNumberMatches(currentChapter.chapterNumber, chapter.chapterNumber);
    const chapterNumber = chapter.chapterNumber?.trim();
    if (!composition && identity.pluginId !== LOCAL_PLUGIN_ID && !identity.chapterPath.startsWith("norea-folder:") && chapterNumber && Number.isFinite(Number(chapterNumber))) {
      await reconcileImportedNovelIdentityInDb(db, { pluginId: identity.pluginId, path: identity.novelPath }, [
        { path: identity.chapterPath, chapterNumber },
      ]);
    }
    await db.execute(`INSERT INTO chapter(novel_id,path,name,chapter_number,position,page,content_type)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(novel_id,path) DO NOTHING`,
    [novelId, identity.chapterPath, chapter.name, chapter.chapterNumber ?? null, chapter.position, chapter.page, chapter.contentType]);
    const chapters = await db.select<{ id: number }[]>("SELECT id FROM chapter WHERE novel_id=$1 AND path=$2", [novelId, identity.chapterPath]);
    return { novelId, chapterId: chapters[0]!.id };
  }, true);
}

export async function markContentInstalled(chapterId: number, contentType: string, contentBytes: number, mediaBytes: number, mediaComplete: boolean): Promise<void> {
  await runDatabaseTransaction(async (db) => {
    const result = await db.execute(`UPDATE chapter SET is_downloaded=$5,stored_content_type=$2,content_bytes=$3,
      media_bytes=$4,media_repair_needed=$6,media_bytes_checked_at=unixepoch(),updated_at=unixepoch() WHERE id=$1`,
    [chapterId, contentType, contentBytes, mediaBytes, Number(mediaComplete), Number(!mediaComplete)]);
    if (result.rowsAffected !== 1) throw new Error("Downloaded chapter no longer exists locally.");
  }, true);
}

export function contentIdentity(pluginId: string, novelPath: string, chapterPath = ""): string {
  return JSON.stringify([pluginId, novelPath, chapterPath]);
}

export interface ContentJournalEntry { sequence: number; key: string }

export async function contentJournalHead(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ sequence: number }[]>("SELECT COALESCE(MAX(sequence),0) AS sequence FROM content_sync_journal");
  return rows[0]?.sequence ?? 0;
}

export async function readContentJournal(after: number, through: number): Promise<ContentJournalEntry[]> {
  const db = await getDb();
  return db.select<ContentJournalEntry[]>(`SELECT j.sequence,j.state_key AS key
    FROM content_sync_journal j JOIN (SELECT MAX(sequence) AS sequence FROM content_sync_journal
    WHERE sequence>$1 AND sequence<=$2 GROUP BY state_key) latest ON latest.sequence=j.sequence ORDER BY j.sequence`, [after, through]);
}

const NOVEL_MIGRATION_CACHE_PREFIX = "norea-content-novel-migration:";

function migrationCacheKey(operationId: string): string {
  return `${NOVEL_MIGRATION_CACHE_PREFIX}${operationId}`;
}

function validMigrationIdentity(value: MigrationWorkIdentity | undefined): value is MigrationWorkIdentity {
  return !!value && [value.pluginId, value.novelId, value.novelPath].every(part => typeof part === "string" && part.trim().length > 0);
}

function parseNovelMigration(payload: string): PendingNovelMigration {
  const job = JSON.parse(payload) as PendingNovelMigration;
  if (job.version !== 1 || typeof job.operationId !== "string" || !job.operationId
    || typeof job.serverUrl !== "string" || !validMigrationIdentity(job.source) || !validMigrationIdentity(job.target)
    || !Array.isArray(job.chapters) || job.chapters.some(chapter => chapter.discardSourceContent !== undefined &&
      (chapter.discardSourceContent !== true || chapter.decision !== null || !chapter.targetChapterPath || chapter.expectedTargetInventory !== undefined))
    || !["pending", "failed", "blocked", "completed"].includes(job.status)
    || (job.targetCoverDeletionRevision !== undefined && (typeof job.targetCoverDeletionRevision !== "string" || !job.targetCoverDeletionRevision))) {
    throw new Error("Stored novel migration is invalid. The source work remains protected.");
  }
  return job;
}

/** Uses the caller's transaction so the source hold cannot outlive a rolled-back merge. */
export async function recordPendingNovelMergeInDb(db: Database, input: {
  serverUrl: string;
  sourceNovelId: number;
  targetNovelId: number;
  chapterIdMap: Readonly<Record<number, number>>;
  skipSourceContentChapterIds?: readonly number[];
  sourceSnapshot?: WorkMigrationSnapshot;
  targetMetadata?: NovelMigrationTargetMetadata;
  preparedDownloads: readonly {
    sourceChapterId: number;
    transferredFromSource: boolean;
    targetInventory?: ChapterPayloadInventory;
    targetInventoryBodyOnly?: boolean;
  }[];
}): Promise<string> {
  const url = new URL(input.serverUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Content server URL is invalid.");
  }
  const serverUrl = url.toString().replace(/\/+$/, "");
  const works = await db.select<(MigrationWorkIdentity & Omit<NovelMetadataV1["novel"], "isLocal"> & { id: number; isLocal: unknown; cover: string | null })[]>(
    `SELECT id,plugin_id AS pluginId,source_novel_id AS novelId,path AS novelPath,
      name,author,artist,summary,status,genres,rating,is_local AS isLocal,cover FROM novel WHERE id IN ($1,$2)`,
    [input.sourceNovelId, input.targetNovelId],
  );
  const source = works.find(work => work.id === input.sourceNovelId);
  const target = works.find(work => work.id === input.targetNovelId);
  if (!validMigrationIdentity(source) || !validMigrationIdentity(target) || source.id === target.id) {
    throw new Error("Both merged works need stable source identities before server migration.");
  }
  if (input.targetMetadata) {
    const expected = input.targetMetadata;
    const parsed = parseNovelMetadata({ schemaVersion: 1, identity: {
      pluginId: target.pluginId, novelId: target.novelId, novelPath: target.novelPath,
    }, novel: expected.novel, cover: expected.cover, chapters: {} });
    const actual = {
      name: target.name, author: target.author, artist: target.artist, summary: target.summary,
      status: target.status, genres: target.genres, rating: target.rating, isLocal: sqliteBoolean(target.isLocal),
    };
    const same = (left: unknown, right: unknown) => JSON.stringify(canonicalMetadataValue(left)) === JSON.stringify(canonicalMetadataValue(right));
    if (!same(parsed.novel, expected.novel)
      || !same(parsed.cover, expected.cover) || expected.novel.isLocal
      || (expected.cover === null ? expected.coverSha256 !== null : !/^[a-f0-9]{64}$/.test(expected.coverSha256 ?? ""))) {
      throw new Error("The captured target metadata is invalid. No novels were merged.");
    }
    if (!same(actual, expected.novel) || Boolean(target.cover?.trim()) !== Boolean(expected.cover)) {
      throw new Error("The target metadata changed before the merge could commit.");
    }
  }
  if (input.sourceSnapshot && (!validMigrationIdentity(input.sourceSnapshot.work?.identity)
    || input.sourceSnapshot.work.identity.pluginId !== source.pluginId
    || input.sourceSnapshot.work.identity.novelId !== source.novelId
    || input.sourceSnapshot.work.identity.novelPath !== source.novelPath
    || typeof input.sourceSnapshot.work.revision !== "string" || !input.sourceSnapshot.work.revision
    || !Array.isArray(input.sourceSnapshot.chapters))) {
    throw new Error("The source server snapshot no longer matches the local work.");
  }
  const rows = await db.select<{ id: number; novelId: number; path: string; chapterNumber: string | null; name: string; position: number; page: string }[]>(
    "SELECT id,novel_id AS novelId,path,chapter_number AS chapterNumber,name,position,page FROM chapter WHERE novel_id IN ($1,$2) ORDER BY id",
    [input.sourceNovelId, input.targetNovelId],
  );
  const targetChapters = new Map(rows.filter(row => row.novelId === input.targetNovelId).map(row => [row.id, row]));
  const prepared = new Map(input.preparedDownloads.map(row => [row.sourceChapterId, row]));
  const skippedSourceContent = new Set(input.skipSourceContentChapterIds ?? []);
  if ([...skippedSourceContent].some(id => !rows.some(row => row.id === id && row.novelId === input.sourceNovelId))) {
    throw new Error("A discarded source chapter no longer exists.");
  }
  const chapters = rows.filter(row => row.novelId === input.sourceNovelId).map(row => {
    const destinationId = input.chapterIdMap[row.id];
    const destination = destinationId === undefined ? undefined : targetChapters.get(destinationId);
    if (destinationId !== undefined && !destination) throw new Error("A server migration target chapter is missing.");
    const artifact = prepared.get(row.id);
    if (artifact && !destination) throw new Error("A server migration download is not mapped.");
    const discardSourceContent = skippedSourceContent.has(row.id);
    if (discardSourceContent && (!destination || artifact?.transferredFromSource)) {
      throw new Error("Discarded source content must keep a target mapping without copying the source body.");
    }
    const decision = discardSourceContent ? null : artifact ? artifact.transferredFromSource ? "copy-source" as const : "keep-target" as const : destination ? "copy-source" as const : null;
    if (decision === "keep-target") {
      const inventory = artifact!.targetInventory;
      if (!isChapterPayloadInventory(inventory) || !inventory.body
        || (inventory.expectedAssetKeys === null
          ? artifact!.targetInventoryBodyOnly !== true || inventory.storedAssets.length !== 0
          : inventory.expectedAssetKeys.some(key => !inventory.storedAssets.some(asset => asset.key === key)))) {
        throw new Error("The retained B download needs a complete verified inventory before merging.");
      }
    }
    return {
      sourceChapterPath: row.path, sourceChapterNumber: row.chapterNumber,
      targetChapterPath: destination?.path ?? null, targetChapterNumber: destination?.chapterNumber ?? null,
      decision,
      ...(discardSourceContent ? { discardSourceContent: true as const } : {}),
      ...(destination ? { targetChapter: { name: destination.name, position: destination.position, page: destination.page } } : {}),
      ...(decision === "keep-target" ? { expectedTargetInventory: artifact!.targetInventory } : {}),
    };
  });
  const identity = (work: MigrationWorkIdentity): MigrationWorkIdentity => ({
    pluginId: work.pluginId, novelId: work.novelId, novelPath: work.novelPath,
  });
  const now = Date.now();
  const job: PendingNovelMigration = {
    version: 1, operationId: crypto.randomUUID(), serverUrl,
    source: identity(source), target: identity(target), targetLocalNovelId: target.id, chapters,
    ...(input.sourceSnapshot ? { sourceSnapshot: input.sourceSnapshot } : {}),
    ...(input.targetMetadata ? { targetMetadata: input.targetMetadata } : {}),
    status: input.sourceSnapshot ? "pending" : "blocked", attempts: 0, createdAt: now, updatedAt: now,
    ...(!input.sourceSnapshot ? { error: "The source server snapshot was unavailable before the local merge. Review the original server work before completing its migration." } : {}),
  };
  await db.execute("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2)", [migrationCacheKey(job.operationId), JSON.stringify(job)]);
  return job.operationId;
}

export async function listNovelMigrations(serverUrl: string, includeCompleted = false): Promise<PendingNovelMigration[]> {
  const db = await getDb();
  const rows = await db.select<{ payload: string }[]>(
    "SELECT payload FROM content_sync_cache WHERE cache_key LIKE $1 ORDER BY cache_key",
    [`${NOVEL_MIGRATION_CACHE_PREFIX}%`],
  );
  return rows.map(row => parseNovelMigration(row.payload))
    .filter(job => job.serverUrl === serverUrl && (includeCompleted || job.status !== "completed"));
}

export async function saveNovelMigration(job: PendingNovelMigration): Promise<void> {
  await writeContentSyncCache(migrationCacheKey(job.operationId), JSON.stringify(job));
}

/** Guard imports inside their existing raw transaction, after any earlier merge has committed. */
export async function isNovelMigrationSourceHeldInDb(
  db: Pick<Database, "select">,
  serverUrl: string,
  identity: MigrationWorkIdentity,
): Promise<boolean> {
  const rows = await db.select<{ held: boolean }[]>(`SELECT EXISTS(
    SELECT 1 FROM content_sync_cache WHERE cache_key LIKE $1
    AND json_extract(payload,'$.serverUrl')=$2 AND json_extract(payload,'$.source.pluginId')=$3
    AND (json_extract(payload,'$.source.novelPath')=$4 OR json_extract(payload,'$.source.novelId')=$5)
    UNION ALL
    SELECT 1 FROM content_sync_cache WHERE cache_key LIKE 'norea-content-incoming-migration:%'
    AND json_extract(payload,'$.serverUrl')=$2 AND json_extract(payload,'$.status')<>'inactive'
    AND json_extract(payload,'$.source.pluginId')=$3
    AND (json_extract(payload,'$.source.novelPath')=$4 OR json_extract(payload,'$.source.novelId')=$5)
    UNION ALL
    SELECT 1 FROM content_sync_cache WHERE cache_key LIKE 'norea-content-chapter-number-reconciliation:%'
    AND json_extract(payload,'$.serverUrl')=$2 AND json_extract(payload,'$.status')='pending'
    AND json_extract(payload,'$.identity.pluginId')=$3
    AND (json_extract(payload,'$.identity.novelPath')=$4 OR json_extract(payload,'$.identity.novelId')=$5)
  ) AS held`, [`${NOVEL_MIGRATION_CACHE_PREFIX}%`, serverUrl, identity.pluginId, identity.novelPath, identity.novelId]);
  return sqliteBoolean(rows[0]?.held);
}
