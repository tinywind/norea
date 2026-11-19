import type { TestSqliteDatabase as Database } from "./sql/types";
import { getChapterComposition } from "./sql/chapter-composition";
import type { DbMutationEffects, DbMutationEnvelope } from "../db/ipc";
import type {
  ContentJournalEntry,
  ContentSyncChapter,
} from "../db/queries/content-sync";
import { reconcileImportedNovelIdentityInDb } from "./sql/novel-identity";
import { coverOverrideInDb, statusOverrideInDb } from "./sql/novel-override";
import { sqliteBoolean } from "./sql/sqlite-value";
import { deferUserStateForNovelInDb } from "./sql/user-state-materialize";
import {
  chapterReference,
  chapterWork,
  hasUserStateSchema,
  recordChapterRowsInDb,
  recordMembershipInDb,
  recordResumeClearedInDb,
  USER_CHAPTER_SELECT,
  type UserChapterRow,
} from "./sql/user-state-core";
import {
  isChapterPayloadInventory,
  type ChapterPayloadInventory,
} from "../lib/chapter-content/inventory";
import { normalizeContentServerUrl } from "../lib/content-sync/client";
import {
  incomingMigrationFromLineage,
  INCOMING_MIGRATION_CACHE_PREFIX,
  parseWorkMigrationLineage,
  type IncomingMigration,
  type WorkMigrationLineage,
} from "../lib/content-sync/migration-feed-state";
import type { PackageManifest } from "../lib/content-sync/native";
import type {
  ExplicitSourceContentDiscard,
  MigrationWorkIdentity,
  NovelMigrationTargetMetadata,
  PendingNovelMigration,
  WorkMigrationSnapshot,
} from "../lib/content-sync/novel-migration-types";
import { contentWorkId } from "../lib/content-sync/works";
import type { ServerChapterSummary } from "../lib/content-sync/chapters";
import { LOCAL_PLUGIN_ID } from "../lib/plugins/types";
import { SERVER_CHAPTER_RENUMBER_PREFIX } from "../lib/source-chapter-renumber";
import { userStateEntityKey } from "../lib/user-state/types";
import {
  canonicalMetadataValue,
  parseNovelMetadata,
  type NovelMetadataV1,
} from "../lib/work-metadata/schema";

const NOVEL_MIGRATION_CACHE_PREFIX = "norea-content-novel-migration:";
const INCOMING_CURSOR_PREFIX = "norea-content-incoming-migration-cursor:";

export interface ContentSyncIpcBridgeOptions {
  getDb: () => Database | Promise<Database>;
  getReadOnlyDb?: () =>
    | Pick<Database, "select">
    | Promise<Pick<Database, "select">>;
  runTransaction: (
    run: (db: Database) => Promise<any>,
    remoteContentSync?: boolean,
  ) => Promise<any>;
}

function assertServerChapterNumberMatches(
  current: string | null | undefined,
  incoming: string | null | undefined,
): void {
  const number = (value: string | null | undefined) =>
    value?.trim() && Number.isFinite(Number(value))
      ? String(Number(value))
      : null;
  const from = number(current);
  const to = number(incoming);
  if (from !== null && to !== null && from !== to) {
    throw new Error(
      "Synchronize the corrected work metadata before importing its chapters. Existing files were retained.",
    );
  }
}

function validMigrationIdentity(
  value: MigrationWorkIdentity | undefined,
): value is MigrationWorkIdentity {
  return (
    !!value &&
    [value.pluginId, value.novelId, value.novelPath].every(
      (part) => typeof part === "string" && part.trim().length > 0,
    )
  );
}

export async function isNovelMigrationSourceHeldInTestDb(
  db: Pick<Database, "select">,
  serverUrl: string,
  identity: MigrationWorkIdentity,
): Promise<boolean> {
  if (!serverUrl.trim()) return false;
  const normalizedServerUrl = normalizeContentServerUrl(serverUrl);
  const rows = await db.select<{ held: boolean }[]>(
    `SELECT EXISTS(
      SELECT 1 FROM content_sync_cache WHERE cache_key LIKE $1
      AND rtrim(json_extract(payload,'$.serverUrl'),'/') IN ($2,$6) AND json_extract(payload,'$.source.pluginId')=$3
      AND (json_extract(payload,'$.source.novelPath')=$4 OR json_extract(payload,'$.source.novelId')=$5)
      UNION ALL
      SELECT 1 FROM content_sync_cache WHERE cache_key LIKE 'norea-content-incoming-migration:%'
      AND rtrim(json_extract(payload,'$.serverUrl'),'/') IN ($2,$6) AND json_extract(payload,'$.status')<>'inactive'
      AND json_extract(payload,'$.source.pluginId')=$3
      AND (json_extract(payload,'$.source.novelPath')=$4 OR json_extract(payload,'$.source.novelId')=$5)
      UNION ALL
      SELECT 1 FROM content_sync_cache WHERE cache_key LIKE 'norea-content-chapter-number-reconciliation:%'
      AND rtrim(json_extract(payload,'$.serverUrl'),'/') IN ($2,$6) AND json_extract(payload,'$.status')='pending'
      AND json_extract(payload,'$.identity.pluginId')=$3
      AND (json_extract(payload,'$.identity.novelPath')=$4 OR json_extract(payload,'$.identity.novelId')=$5)
    ) AS held`,
    [
      `${NOVEL_MIGRATION_CACHE_PREFIX}%`,
      normalizedServerUrl,
      identity.pluginId,
      identity.novelPath,
      identity.novelId,
      serverUrl.trim().replace(/\/+$/, ""),
    ],
  );
  return sqliteBoolean(rows[0]?.held);
}

export async function releaseMigratedTargetMetadataInTestDb(
  db: Database,
  server: string,
  identity: NovelMetadataV1["identity"],
): Promise<void> {
  const key = `norea-content-works:${normalizeContentServerUrl(server)}`;
  const rows = await db.select<{ payload: string }[]>(
    "SELECT payload FROM content_sync_cache WHERE cache_key=$1",
    [key],
  );
  if (!rows[0]) return;
  const cache = JSON.parse(rows[0].payload) as {
    cursor: number;
    fingerprints: Record<string, string>;
    fileVersions: Record<string, string>;
    deleted: Record<string, boolean>;
  };
  const id = await contentWorkId(identity);
  delete cache.deleted[id];
  delete cache.fingerprints[id];
  delete cache.fileVersions[
    JSON.stringify([identity.pluginId, identity.novelPath])
  ];
  await db.execute(
    "UPDATE content_sync_cache SET payload=$1 WHERE cache_key=$2",
    [JSON.stringify(cache), key],
  );
}

export async function recordPendingNovelMergeInTestDb(
  db: Database,
  input: {
    serverUrl: string;
    sourceNovelId: number;
    targetNovelId: number;
    chapterIdMap: Readonly<Record<number, number>>;
    skipSourceContentChapterIds?: readonly number[];
    explicitServerDiscardBySourceId?: Readonly<
      Record<number, ExplicitSourceContentDiscard>
    >;
    sourceSnapshot?: WorkMigrationSnapshot;
    targetMetadata?: NovelMigrationTargetMetadata;
    preparedDownloads: readonly {
      sourceChapterId: number;
      transferredFromSource: boolean;
      targetInventory?: ChapterPayloadInventory;
      targetInventoryBodyOnly?: boolean;
    }[];
  },
): Promise<string> {
  const url = new URL(input.serverUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Content server URL is invalid.");
  }
  const serverUrl = url.toString().replace(/\/+$/, "");
  const works = await db.select<
    (MigrationWorkIdentity &
      Omit<NovelMetadataV1["novel"], "isLocal"> & {
        id: number;
        isLocal: unknown;
        cover: string | null;
      })[]
  >(
    `SELECT id,plugin_id AS pluginId,source_novel_id AS novelId,path AS novelPath,
      name,author,artist,summary,status,genres,rating,is_local AS isLocal,cover FROM novel WHERE id IN ($1,$2)`,
    [input.sourceNovelId, input.targetNovelId],
  );
  const source = works.find((work) => work.id === input.sourceNovelId);
  const target = works.find((work) => work.id === input.targetNovelId);
  if (
    !validMigrationIdentity(source) ||
    !validMigrationIdentity(target) ||
    source.id === target.id
  ) {
    throw new Error(
      "Both merged works need stable source identities before server migration.",
    );
  }
  if (input.targetMetadata) {
    const expected = input.targetMetadata;
    const parsed = parseNovelMetadata({
      schemaVersion: 1,
      identity: {
        pluginId: target.pluginId,
        novelId: target.novelId,
        novelPath: target.novelPath,
      },
      novel: expected.novel,
      cover: expected.cover,
      chapters: {},
    });
    const actual = {
      name: target.name,
      author: target.author,
      artist: target.artist,
      summary: target.summary,
      status: target.status,
      genres: target.genres,
      rating: target.rating,
      isLocal: sqliteBoolean(target.isLocal),
    };
    const same = (left: unknown, right: unknown) =>
      JSON.stringify(canonicalMetadataValue(left)) ===
      JSON.stringify(canonicalMetadataValue(right));
    if (
      !same(parsed.novel, expected.novel) ||
      !same(parsed.cover, expected.cover) ||
      expected.novel.isLocal ||
      (expected.cover === null
        ? expected.coverSha256 !== null
        : !/^[a-f0-9]{64}$/.test(expected.coverSha256 ?? ""))
    ) {
      throw new Error(
        "The captured target metadata is invalid. No novels were merged.",
      );
    }
    if (
      !same(actual, expected.novel) ||
      Boolean(target.cover?.trim()) !== Boolean(expected.cover)
    ) {
      throw new Error(
        "The target metadata changed before the merge could commit.",
      );
    }
  }
  if (
    input.sourceSnapshot &&
    (!validMigrationIdentity(input.sourceSnapshot.work?.identity) ||
      input.sourceSnapshot.work.identity.pluginId !== source.pluginId ||
      input.sourceSnapshot.work.identity.novelId !== source.novelId ||
      input.sourceSnapshot.work.identity.novelPath !== source.novelPath ||
      typeof input.sourceSnapshot.work.revision !== "string" ||
      !input.sourceSnapshot.work.revision ||
      !Array.isArray(input.sourceSnapshot.chapters))
  ) {
    throw new Error(
      "The source server snapshot no longer matches the local work.",
    );
  }
  const rows = await db.select<
    {
      id: number;
      novelId: number;
      path: string;
      chapterNumber: string | null;
      name: string;
      position: number;
      page: string;
    }[]
  >(
    "SELECT id,novel_id AS novelId,path,chapter_number AS chapterNumber,name,position,page FROM chapter WHERE novel_id IN ($1,$2) ORDER BY id",
    [input.sourceNovelId, input.targetNovelId],
  );
  const targetChapters = new Map(
    rows
      .filter((row) => row.novelId === input.targetNovelId)
      .map((row) => [row.id, row]),
  );
  const prepared = new Map(
    input.preparedDownloads.map((row) => [row.sourceChapterId, row]),
  );
  const skippedSourceContent = new Set(input.skipSourceContentChapterIds ?? []);
  const explicitDiscards = input.explicitServerDiscardBySourceId ?? {};
  const validSourceIds = new Set(
    rows
      .filter((row) => row.novelId === input.sourceNovelId)
      .map((row) => row.id),
  );
  if (
    [...skippedSourceContent].some((id) => !validSourceIds.has(id)) ||
    Object.keys(explicitDiscards).some((id) => !validSourceIds.has(Number(id)))
  ) {
    throw new Error("A skipped or discarded source chapter no longer exists.");
  }
  const chapters = rows
    .filter((row) => row.novelId === input.sourceNovelId)
    .map((row) => {
      const destinationId = input.chapterIdMap[row.id];
      const destination =
        destinationId === undefined
          ? undefined
          : targetChapters.get(destinationId);
      if (destinationId !== undefined && !destination) {
        throw new Error("A server migration target chapter is missing.");
      }
      const artifact = prepared.get(row.id);
      if (artifact && !destination) {
        throw new Error("A server migration download is not mapped.");
      }
      if (
        skippedSourceContent.has(row.id) &&
        (!destination || artifact?.transferredFromSource)
      ) {
        throw new Error(
          "Skipped local source content must keep a target mapping without copying the source body.",
        );
      }
      const explicitDiscard = explicitDiscards[row.id];
      if (explicitDiscard !== undefined) {
        if (
          explicitDiscard.approvedByUser !== true ||
          !isChapterPayloadInventory(explicitDiscard.expectedSourceInventory) ||
          !explicitDiscard.expectedSourceInventory.body ||
          artifact?.transferredFromSource
        ) {
          throw new Error(
            "Explicit server content discard requires a verified source inventory without copying the source body.",
          );
        }
        return {
          sourceChapterPath: row.path,
          sourceChapterNumber: row.chapterNumber,
          targetChapterPath: destination?.path ?? null,
          targetChapterNumber: destination?.chapterNumber ?? null,
          decision: null,
          ...(destination ? { discardSourceContent: true as const } : {}),
          explicitSourceDiscard: explicitDiscard,
          ...(destination
            ? {
                targetChapter: {
                  name: destination.name,
                  position: destination.position,
                  page: destination.page,
                },
              }
            : {}),
        };
      }
      const decision = artifact
        ? artifact.transferredFromSource
          ? ("copy-source" as const)
          : ("keep-target" as const)
        : destination
          ? ("copy-source" as const)
          : null;
      if (decision === "keep-target") {
        const inventory = artifact!.targetInventory;
        if (
          !isChapterPayloadInventory(inventory) ||
          !inventory.body ||
          (inventory.expectedAssetKeys === null
            ? artifact!.targetInventoryBodyOnly !== true ||
              inventory.storedAssets.length !== 0
            : inventory.expectedAssetKeys.some(
                (key) =>
                  !inventory.storedAssets.some((asset) => asset.key === key),
              ))
        ) {
          throw new Error(
            "The retained B download needs a complete verified inventory before merging.",
          );
        }
      }
      return {
        sourceChapterPath: row.path,
        sourceChapterNumber: row.chapterNumber,
        targetChapterPath: destination?.path ?? null,
        targetChapterNumber: destination?.chapterNumber ?? null,
        decision,
        ...(artifact?.transferredFromSource
          ? { requiresTargetUpload: true as const }
          : {}),
        ...(destination
          ? {
              targetChapter: {
                name: destination.name,
                position: destination.position,
                page: destination.page,
              },
            }
          : {}),
        ...(decision === "keep-target"
          ? { expectedTargetInventory: artifact!.targetInventory }
          : {}),
      };
    });
  const identity = (work: MigrationWorkIdentity): MigrationWorkIdentity => ({
    pluginId: work.pluginId,
    novelId: work.novelId,
    novelPath: work.novelPath,
  });
  const normalizedServerUrl = normalizeContentServerUrl(serverUrl);
  const now = Date.now();
  const job: PendingNovelMigration = {
    version: 1,
    operationId: crypto.randomUUID(),
    serverUrl: normalizedServerUrl,
    source: identity(source),
    target: identity(target),
    targetLocalNovelId: target.id,
    chapters,
    ...(input.sourceSnapshot ? { sourceSnapshot: input.sourceSnapshot } : {}),
    ...(input.targetMetadata ? { targetMetadata: input.targetMetadata } : {}),
    status: input.sourceSnapshot ? "pending" : "blocked",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...(!input.sourceSnapshot
      ? {
          error:
            "The source server snapshot was unavailable before the local merge. Review the original server work before completing its migration.",
        }
      : {}),
  };
  await db.execute(
    "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2)",
    [`${NOVEL_MIGRATION_CACHE_PREFIX}${job.operationId}`, JSON.stringify(job)],
  );
  return job.operationId;
}

const receiptKey = (server: string, operationId: string) =>
  INCOMING_MIGRATION_CACHE_PREFIX + JSON.stringify([server, operationId]);
const serverReceiptPrefix = (server: string) =>
  INCOMING_MIGRATION_CACHE_PREFIX + JSON.stringify([server]).slice(0, -1) + ",";

function parseStoredIncoming(row: {
  cacheKey: string;
  payload: string;
}): IncomingMigration {
  const raw = JSON.parse(row.payload) as IncomingMigration;
  const lineage = parseWorkMigrationLineage(raw.lineage);
  const serverUrl = normalizeContentServerUrl(raw.serverUrl);
  if (
    raw.version !== 1 ||
    raw.operationId !== lineage.operationId ||
    raw.sequence !== lineage.sequence
  ) {
    throw new Error(
      "Incoming work migration is invalid: stored receipt. Synchronization was held.",
    );
  }
  if (row.cacheKey !== receiptKey(serverUrl, lineage.operationId)) {
    throw new Error(
      "Incoming work migration is invalid: receipt cache identity. Synchronization was held.",
    );
  }
  return {
    version: 1,
    serverUrl,
    operationId: lineage.operationId,
    sequence: lineage.sequence,
    source: { ...lineage.sourceWork.identity },
    target: { ...lineage.targetWork.identity },
    status: raw.status,
    lineage,
    ...(raw.error === undefined ? {} : { error: raw.error }),
  };
}

export async function listIncomingMigrationsInTestDb(
  connection: Pick<Database, "select">,
  server: string,
  includeCompleted = false,
): Promise<IncomingMigration[]> {
  const serverUrl = normalizeContentServerUrl(server);
  const prefix = serverReceiptPrefix(serverUrl);
  const rows = await connection.select<{ cacheKey: string; payload: string }[]>(
    "SELECT cache_key AS cacheKey,payload FROM content_sync_cache WHERE substr(cache_key,1,length($1))=$1 ORDER BY cache_key",
    [prefix],
  );
  return rows
    .map(parseStoredIncoming)
    .filter(
      (value) =>
        includeCompleted ||
        (value.status !== "completed" && value.status !== "inactive"),
    )
    .sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.operationId.localeCompare(right.operationId),
    );
}

export async function saveIncomingMigrationInTestDb(
  connection: Database,
  record: IncomingMigration,
): Promise<IncomingMigration> {
  const serverUrl = normalizeContentServerUrl(record.serverUrl);
  const lineage = parseWorkMigrationLineage(record.lineage);
  const proposed: IncomingMigration = {
    version: 1,
    serverUrl,
    operationId: lineage.operationId,
    sequence: lineage.sequence,
    source: { ...lineage.sourceWork.identity },
    target: { ...lineage.targetWork.identity },
    status: record.status,
    lineage,
    ...(record.error === undefined ? {} : { error: record.error }),
  };
  const key = receiptKey(proposed.serverUrl, proposed.operationId);
  const rows = await connection.select<{ cacheKey: string; payload: string }[]>(
    "SELECT cache_key AS cacheKey,payload FROM content_sync_cache WHERE cache_key=$1",
    [key],
  );
  const previous = rows[0] && parseStoredIncoming(rows[0]);
  const checked = incomingMigrationFromLineage(
    proposed.serverUrl,
    proposed.lineage,
    previous,
  );
  const selected =
    checked.sequence > proposed.sequence ||
    (checked.status === "completed" && proposed.status !== "inactive")
      ? checked
      : proposed;
  await connection.execute(
    "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
    [key, JSON.stringify(selected)],
  );
  return selected;
}

async function getIncomingMigrationCursorInTestDb(
  connection: Pick<Database, "select">,
  server: string,
): Promise<number> {
  const serverUrl = normalizeContentServerUrl(server);
  const rows = await connection.select<{ payload: string }[]>(
    "SELECT payload FROM content_sync_cache WHERE cache_key=$1",
    [INCOMING_CURSOR_PREFIX + serverUrl],
  );
  if (!rows[0]) return 0;
  const parsed = JSON.parse(rows[0].payload) as {
    version?: unknown;
    serverUrl?: unknown;
    cursor?: unknown;
  };
  if (
    parsed.version !== 1 ||
    parsed.serverUrl !== serverUrl ||
    typeof parsed.cursor !== "number" ||
    !Number.isSafeInteger(parsed.cursor) ||
    parsed.cursor < 0
  ) {
    throw new Error(
      "Incoming work migration is invalid: stored cursor. Synchronization was held.",
    );
  }
  return parsed.cursor;
}

async function saveIncomingMigrationCursorInTestDb(
  connection: Database,
  server: string,
  cursor: number,
): Promise<void> {
  const serverUrl = normalizeContentServerUrl(server);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error(
      "Incoming work migration is invalid: sequence. Synchronization was held.",
    );
  }
  const previous = await getIncomingMigrationCursorInTestDb(
    connection,
    serverUrl,
  );
  await connection.execute(
    "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
    [
      INCOMING_CURSOR_PREFIX + serverUrl,
      JSON.stringify({
        version: 1,
        serverUrl,
        cursor: Math.max(previous, cursor),
      }),
    ],
  );
}

async function selectContentSyncChaptersInTestDb(
  db: Pick<Database, "select">,
  identities: string[] | undefined,
  downloadedOnly: boolean,
  matchWorks: boolean,
): Promise<ContentSyncChapter[]> {
  if (identities?.length === 0) return [];
  if (identities && identities.length > 100) {
    const rows: ContentSyncChapter[] = [];
    for (let offset = 0; offset < identities.length; offset += 100) {
      rows.push(
        ...(await selectContentSyncChaptersInTestDb(
          db,
          identities.slice(offset, offset + 100),
          downloadedOnly,
          matchWorks,
        )),
      );
    }
    return rows;
  }
  const targets = identities?.flatMap(
    (identity) => JSON.parse(identity) as string[],
  );
  const columns = matchWorks
    ? ["plugin_id", "novel_path"]
    : ["plugin_id", "novel_path", "chapter_path"];
  const prefix = identities
    ? `WITH targets(${columns.join(",")}) AS (VALUES ${identities
        .map(
          (_, i) =>
            `(${columns.map((_, column) => `$${i * columns.length + column + 1}`).join(",")})`,
        )
        .join(",")})`
    : "";
  const from = identities
    ? `targets t JOIN novel n ON n.plugin_id=t.plugin_id AND n.path=t.novel_path JOIN chapter c ON c.novel_id=n.id${matchWorks ? "" : " AND c.path=t.chapter_path"}`
    : "chapter c JOIN novel n ON n.id=c.novel_id";
  const rows = await db.select<ContentSyncChapter[]>(
    `${prefix} SELECT
      c.id AS chapterId, n.id AS novelId, n.plugin_id AS pluginId, n.path AS novelPath, n.source_novel_id AS sourceNovelId,
      c.path AS chapterPath, n.name AS novelName, n.author, n.summary,
      n.is_local AS isLocal,
      c.name AS chapterName, c.chapter_number AS chapterNumber, c.position, c.page,
      COALESCE(c.stored_content_type,c.content_type) AS contentType,
      c.is_downloaded AS isDownloaded, c.media_repair_needed AS mediaRepairNeeded,
      c.content_bytes AS contentBytes, c.media_bytes AS mediaBytes,
      EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id=c.id) AS isDownloadQueued
      FROM ${from} ${downloadedOnly ? "WHERE (c.is_downloaded=1 OR c.content_bytes>0)" : ""} ORDER BY n.id,c.position,c.id`,
    targets,
  );
  return rows.map((row) => ({
    ...row,
    isLocal: sqliteBoolean(row.isLocal),
    isDownloaded: sqliteBoolean(row.isDownloaded),
    mediaRepairNeeded: sqliteBoolean(row.mediaRepairNeeded),
    isDownloadQueued: sqliteBoolean(row.isDownloadQueued),
  }));
}

async function readJournalSeq(db: Pick<Database, "select">): Promise<number> {
  try {
    const rows = await db.select<{ sequence: number }[]>(
      "SELECT COALESCE(MAX(sequence),0) AS sequence FROM content_sync_journal",
    );
    return rows[0]?.sequence ?? 0;
  } catch {
    return 0;
  }
}

export function createContentSyncIpcHandler(
  options: ContentSyncIpcBridgeOptions,
) {
  const selectDb = async (readMode?: string) =>
    readMode === "concurrent" && options.getReadOnlyDb
      ? options.getReadOnlyDb()
      : options.getDb();

  return {
    async handle(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<{ handled: true; result: unknown } | { handled: false }> {
      if (command === "db_content_sync_cache_server_chapters") {
        const novelId = args.novelId as number;
        const chapters = (args.chapters ?? []) as ServerChapterSummary[];
        let seq = 0;
        const value = await options.runTransaction(async (db) => {
          const [novel] = await db.select<{ pluginId: string; path: string }[]>(
            "SELECT plugin_id AS pluginId, path FROM novel WHERE id=$1",
            [novelId],
          );
          const existing = await db.select<
            { path: string; chapterNumber: string | null }[]
          >(
            "SELECT path,chapter_number AS chapterNumber FROM chapter WHERE novel_id=$1",
            [novelId],
          );
          const paths = new Set(existing.map((chapter) => chapter.path));
          const byPath = new Map(
            existing.map((chapter) => [chapter.path, chapter.chapterNumber]),
          );
          const numbers = new Map<string, string[]>();
          for (const chapter of existing) {
            if (
              !chapter.chapterNumber?.trim() ||
              !Number.isFinite(Number(chapter.chapterNumber))
            ) {
              continue;
            }
            const number = String(Number(chapter.chapterNumber));
            numbers.set(number, [...(numbers.get(number) ?? []), chapter.path]);
          }
          const composition = await getChapterComposition(db, novelId);
          const included = composition
            ? new Map(
                composition.entries
                  .filter((entry) => entry.user.included)
                  .map((entry) => [entry.path, entry]),
              )
            : null;
          const isLocalPlugin = novel?.pluginId === LOCAL_PLUGIN_ID;
          const incoming: Array<
            Omit<ServerChapterSummary, "contentType"> & { contentType: string }
          > = [];
          let changed = false;
          for (const chapter of chapters) {
            if (included && !included.has(chapter.chapterPath)) continue;
            if (paths.has(chapter.chapterPath)) {
              assertServerChapterNumberMatches(
                byPath.get(chapter.chapterPath),
                chapter.chapterNumber,
              );
              continue;
            }
            const number =
              !isLocalPlugin &&
              chapter.chapterNumber?.trim() &&
              Number.isFinite(Number(chapter.chapterNumber))
                ? String(Number(chapter.chapterNumber))
                : null;
            const matches = number === null ? [] : (numbers.get(number) ?? []);
            if (matches.length) {
              if (matches.length > 1) {
                throw new Error(
                  "Server chapter number matches multiple local chapters.",
                );
              }
              const existingPath = matches[0]!;
              if (
                !composition &&
                !isLocalPlugin &&
                existingPath.startsWith("norea-folder:") &&
                !chapter.chapterPath.startsWith("norea-folder:") &&
                !paths.has(chapter.chapterPath)
              ) {
                const updated = await db.execute(
                  "UPDATE chapter SET path=$1, page=CASE WHEN page='' THEN $2 ELSE page END WHERE novel_id=$3 AND path=$4",
                  [chapter.chapterPath, chapter.page, novelId, existingPath],
                );
                if (updated.rowsAffected > 0) {
                  changed = true;
                  if (novel) {
                    const existingState = await db.select<{ present: number }[]>(
                      "SELECT EXISTS(SELECT 1 FROM work_metadata_reading_state WHERE plugin_id=$1 AND novel_path=$2 AND chapter_path=$3) AS present",
                      [novel.pluginId, novel.path, chapter.chapterPath],
                    );
                    if (!existingState[0]?.present) {
                      await db.execute(
                        "UPDATE work_metadata_reading_state SET chapter_path=$1 WHERE plugin_id=$2 AND novel_path=$3 AND chapter_path=$4",
                        [chapter.chapterPath, novel.pluginId, novel.path, existingPath],
                      );
                    }
                  }
                  paths.delete(existingPath);
                  paths.add(chapter.chapterPath);
                  const existingNum = byPath.get(existingPath) ?? null;
                  byPath.delete(existingPath);
                  byPath.set(chapter.chapterPath, existingNum);
                  if (number !== null) numbers.set(number, [chapter.chapterPath]);
                }
              }
              continue;
            }
            const entry = included?.get(chapter.chapterPath);
            if (entry) {
              assertServerChapterNumberMatches(
                entry.storageChapterNumber,
                chapter.chapterNumber,
              );
              const source = entry.sources[entry.primarySource];
              incoming.push({
                ...chapter,
                name: entry.user.name ?? source.name,
                position: entry.user.order,
                page: source.page,
                contentType: source.contentType,
              });
            } else {
              incoming.push(chapter);
            }
            paths.add(chapter.chapterPath);
            if (number !== null) numbers.set(number, [chapter.chapterPath]);
          }
          for (let offset = 0; offset < incoming.length; offset += 100) {
            const batch = incoming.slice(offset, offset + 100);
            const result = await db.execute(
              `INSERT INTO chapter(novel_id,path,name,chapter_number,position,page,content_type)
               VALUES ${batch
                 .map(
                   (_, index) =>
                     `(${Array.from({ length: 7 }, (_, column) => `$${index * 7 + column + 1}`).join(",")})`,
                 )
                 .join(",")}
               ON CONFLICT(novel_id,path) DO NOTHING`,
              batch.flatMap((chapter) => [
                novelId,
                chapter.chapterPath,
                chapter.name,
                chapter.chapterNumber ?? null,
                chapter.position,
                chapter.page,
                chapter.contentType,
              ]),
            );
            changed ||= result.rowsAffected > 0;
          }
          if (changed && !composition && !isLocalPlugin) {
            const rows = await db.select<{ id: number; chapterNumber: string | null; position: number }[]>(
              "SELECT id, chapter_number AS chapterNumber, position FROM chapter WHERE novel_id=$1 ORDER BY position ASC, id ASC",
              [novelId],
            );
            const parsed = rows.map((row) => {
              const trimmed = row.chapterNumber?.trim();
              if (!trimmed || !Number.isFinite(Number(trimmed))) return null;
              return { id: row.id, num: Number(trimmed), position: row.position };
            });
            if (parsed.every((item): item is NonNullable<typeof item> => item !== null)) {
              parsed.sort((lhs, rhs) => lhs.num - rhs.num || lhs.id - rhs.id);
              for (const [idx, item] of parsed.entries()) {
                const nextPos = idx + 1;
                if (item.position !== nextPos) {
                  await db.execute("UPDATE chapter SET position=$1 WHERE id=$2", [nextPos, item.id]);
                }
              }
            }
          }
          if (changed) {
            await deferUserStateForNovelInDb(db, novelId);
          }
          seq = await readJournalSeq(db);
          return changed;
        }, true);
        return {
          handled: true,
          result: {
            value,
            effects: { contentSyncMaxSequence: seq },
          } satisfies DbMutationEnvelope<boolean>,
        };
      }

      if (command === "db_content_sync_read_cache") {
        const db = await selectDb(args.readMode as string | undefined);
        const rows = await db.select<{ payload: string }[]>(
          "SELECT payload FROM content_sync_cache WHERE cache_key=$1",
          [args.key],
        );
        return { handled: true, result: rows[0]?.payload ?? null };
      }

      if (command === "db_content_sync_write_cache") {
        const db = await options.getDb();
        await db.execute(
          "INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,$2) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
          [args.key, args.payload],
        );
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_content_sync_clear_download_proof") {
        const db = await options.getDb();
        await db.execute(
          "DELETE FROM content_sync_cache WHERE cache_key=$1",
          [`norea-content-chapter-source:${args.chapterId as number}`],
        );
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_content_sync_list_cache_entries") {
        const db = await selectDb(args.readMode as string | undefined);
        const prefix = args.prefix as string;
        const exactSubstr = args.exactSubstr !== false;
        const rows = exactSubstr
          ? await db.select<{ cacheKey: string; payload: string }[]>(
              "SELECT cache_key AS cacheKey,payload FROM content_sync_cache WHERE substr(cache_key,1,length($1))=$1 ORDER BY cache_key",
              [prefix],
            )
          : await db.select<{ cacheKey: string; payload: string }[]>(
              "SELECT cache_key AS cacheKey,payload FROM content_sync_cache WHERE cache_key LIKE $1 ORDER BY cache_key",
              [`${prefix}%`],
            );
        return { handled: true, result: rows };
      }

      if (command === "db_content_sync_list_pending_renumber_reconciliations") {
        const db = await selectDb(args.readMode as string | undefined);
        const rows = await db.select<{ payload: string }[]>(
          "SELECT payload FROM content_sync_cache WHERE cache_key LIKE $1 AND json_extract(payload,'$.status')='pending' " +
            "ORDER BY json_extract(payload,'$.createdAt'),cache_key",
          [SERVER_CHAPTER_RENUMBER_PREFIX + "%"],
        );
        return { handled: true, result: rows.map((row) => row.payload) };
      }

      if (command === "db_content_sync_list_chapters") {
        const db = await selectDb(args.readMode as string | undefined);
        const rows = await selectContentSyncChaptersInTestDb(
          db,
          (args.identities as string[] | null | undefined) ?? undefined,
          Boolean(args.downloadedOnly),
          Boolean(args.matchWorks),
        );
        return { handled: true, result: rows };
      }

      if (command === "db_content_sync_list_untracked_chapters") {
        const db = options.getReadOnlyDb
          ? await options.getReadOnlyDb()
          : await options.getDb();
        const rows = await db.select<ContentSyncChapter[]>(
          `WITH known(key) AS MATERIALIZED (
            SELECT entry.key
            FROM content_sync_cache cache, json_each(cache.payload,'$.downloads') entry
            WHERE cache.cache_key=$1
          )
          SELECT
            c.id AS chapterId, n.id AS novelId, n.plugin_id AS pluginId, n.path AS novelPath, n.source_novel_id AS sourceNovelId,
            c.path AS chapterPath, n.name AS novelName, n.author, n.summary,
            n.is_local AS isLocal,
            c.name AS chapterName, c.chapter_number AS chapterNumber, c.position, c.page,
            COALESCE(c.stored_content_type,c.content_type) AS contentType,
            c.is_downloaded AS isDownloaded, c.media_repair_needed AS mediaRepairNeeded,
            c.content_bytes AS contentBytes, c.media_bytes AS mediaBytes,
            EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id=c.id) AS isDownloadQueued
          FROM chapter c
          JOIN novel n ON n.id=c.novel_id
          LEFT JOIN known ON known.key=json_array(n.plugin_id,n.path,c.path)
          WHERE n.source_novel_id IS NOT NULL
            AND n.is_local=0
            AND n.plugin_id<>'local'
            AND (c.is_downloaded=1 OR c.content_bytes>0)
            AND known.key IS NULL
          ORDER BY n.id,c.position,c.id`,
          ["norea-content-catalog:" + (args.serverUrl as string)],
        );
        return {
          handled: true,
          result: rows.map((row) => ({
            ...row,
            isLocal: sqliteBoolean(row.isLocal),
            isDownloaded: sqliteBoolean(row.isDownloaded),
            mediaRepairNeeded: sqliteBoolean(row.mediaRepairNeeded),
            isDownloadQueued: sqliteBoolean(row.isDownloadQueued),
          })),
        };
      }

      if (command === "db_content_sync_can_upload_chapter") {
        const db = await selectDb(args.readMode as string | undefined);
        const rows = await db.select<{ ready: boolean }[]>(
          `SELECT EXISTS(
            SELECT 1 FROM chapter c JOIN novel n ON n.id=c.novel_id
            WHERE c.id=$1 AND n.is_local=0 AND n.plugin_id<>'local'
            AND (c.is_downloaded=1 OR c.content_bytes>0)
            AND NOT EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id=c.id)
          ) AS ready`,
          [args.chapterId],
        );
        return { handled: true, result: sqliteBoolean(rows[0]?.ready) };
      }

      if (command === "db_content_sync_import_metadata") {
        const manifest = args.manifest as PackageManifest;
        const serverUrl = (args.serverUrl as string | null | undefined) ?? undefined;
        let seq = 0;
        const value = await options.runTransaction(async (db) => {
          const { identity, chapter } = manifest;
          if (
            serverUrl &&
            (await isNovelMigrationSourceHeldInTestDb(db, serverUrl, identity))
          ) {
            throw new Error(
              "The original work is held while its server migration completes.",
            );
          }
          const novels = await db.select<
            { id: number; sourceNovelId: string | null }[]
          >(
            "SELECT id,source_novel_id AS sourceNovelId FROM novel WHERE plugin_id=$1 AND path=$2",
            [identity.pluginId, identity.novelPath],
          );
          if (!novels.length) {
            throw new Error(
              "Install the work metadata before downloading its chapters.",
            );
          }
          if (novels[0]!.sourceNovelId !== identity.novelId) {
            throw new Error(
              "Server chapter novel ID does not match the installed work.",
            );
          }
          const novelId = novels[0]!.id;
          const composition = await getChapterComposition(db, novelId);
          const compositionEntry = composition?.entries.find(
            (entry) => entry.path === identity.chapterPath,
          );
          if (
            composition &&
            (!compositionEntry?.user.included ||
              compositionEntry.storageChapterNumber !==
                (chapter.chapterNumber ?? undefined) &&
                compositionEntry.storageChapterNumber !==
                  chapter.chapterNumber)
          ) {
            throw new Error(
              "The server chapter is excluded from the final chapter list or has a different storage identity.",
            );
          }
          const [currentChapter] = await db.select<
            { chapterNumber: string | null }[]
          >(
            "SELECT chapter_number AS chapterNumber FROM chapter WHERE novel_id=$1 AND path=$2",
            [novelId, identity.chapterPath],
          );
          if (currentChapter) {
            assertServerChapterNumberMatches(
              currentChapter.chapterNumber,
              chapter.chapterNumber,
            );
          }
          const chapterNumber = chapter.chapterNumber?.trim();
          if (
            !composition &&
            identity.pluginId !== LOCAL_PLUGIN_ID &&
            !identity.chapterPath.startsWith("norea-folder:") &&
            chapterNumber &&
            Number.isFinite(Number(chapterNumber))
          ) {
            await reconcileImportedNovelIdentityInDb(
              db,
              { pluginId: identity.pluginId, path: identity.novelPath },
              [{ path: identity.chapterPath, chapterNumber }],
            );
          }
          await db.execute(
            `INSERT INTO chapter(novel_id,path,name,chapter_number,position,page,content_type)
             VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(novel_id,path) DO NOTHING`,
            [
              novelId,
              identity.chapterPath,
              chapter.name,
              chapter.chapterNumber ?? null,
              chapter.position,
              chapter.page,
              chapter.contentType,
            ],
          );
          const chapters = await db.select<{ id: number }[]>(
            "SELECT id FROM chapter WHERE novel_id=$1 AND path=$2",
            [novelId, identity.chapterPath],
          );
          await deferUserStateForNovelInDb(db, novelId);
          seq = await readJournalSeq(db);
          return { novelId, chapterId: chapters[0]!.id };
        }, true);
        return {
          handled: true,
          result: {
            value,
            effects: { contentSyncMaxSequence: seq },
          } satisfies DbMutationEnvelope<{ novelId: number; chapterId: number }>,
        };
      }

      if (command === "db_content_sync_mark_installed") {
        const chapterId = args.chapterId as number;
        const contentType = args.contentType as string;
        const contentBytes = args.contentBytes as number;
        const mediaBytes = args.mediaBytes as number;
        const mediaComplete = Boolean(args.mediaComplete);
        let seq = 0;
        await options.runTransaction(async (db) => {
          const result = await db.execute(
            `UPDATE chapter SET is_downloaded=$5,stored_content_type=$2,content_bytes=$3,
             media_bytes=$4,media_repair_needed=$6,media_bytes_checked_at=unixepoch(),updated_at=unixepoch() WHERE id=$1`,
            [
              chapterId,
              contentType,
              contentBytes,
              mediaBytes,
              Number(mediaComplete),
              Number(!mediaComplete),
            ],
          );
          if (result.rowsAffected !== 1) {
            throw new Error("Downloaded chapter no longer exists locally.");
          }
          seq = await readJournalSeq(db);
        }, true);
        return {
          handled: true,
          result: {
            value: null,
            effects: { contentSyncMaxSequence: seq },
          } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_content_sync_journal_head") {
        const db = await selectDb(args.readMode as string | undefined);
        const rows = await db.select<{ sequence: number }[]>(
          "SELECT COALESCE(MAX(sequence),0) AS sequence FROM content_sync_journal",
        );
        return { handled: true, result: rows[0]?.sequence ?? 0 };
      }

      if (command === "db_content_sync_read_journal") {
        const db = await selectDb(args.readMode as string | undefined);
        const rows = await db.select<ContentJournalEntry[]>(
          `SELECT j.sequence,j.state_key AS key
           FROM content_sync_journal j JOIN (SELECT MAX(sequence) AS sequence FROM content_sync_journal
           WHERE sequence>$1 AND sequence<=$2 GROUP BY state_key) latest ON latest.sequence=j.sequence ORDER BY j.sequence`,
          [args.after, args.through],
        );
        return { handled: true, result: rows };
      }

      if (command === "db_content_sync_is_migration_source_held") {
        const db = await selectDb(args.readMode as string | undefined);
        const held = await isNovelMigrationSourceHeldInTestDb(
          db,
          args.serverUrl as string,
          args.identity as MigrationWorkIdentity,
        );
        return { handled: true, result: held };
      }

      if (command === "db_content_sync_record_pending_novel_merge") {
        const input = args.input as Parameters<
          typeof recordPendingNovelMergeInTestDb
        >[1];
        const value = await options.runTransaction((db) =>
          recordPendingNovelMergeInTestDb(db, input),
        );
        return {
          handled: true,
          result: { value, effects: {} } satisfies DbMutationEnvelope<string>,
        };
      }

      if (command === "db_content_sync_list_incoming_migration_summaries") {
        const db = await selectDb(args.readMode as string | undefined);
        const includeCompleted = Boolean(args.includeCompleted);
        const items = await listIncomingMigrationsInTestDb(
          db,
          args.serverUrl as string,
          includeCompleted,
        );
        return {
          handled: true,
          result: items.map((item) => ({
            version: 1 as const,
            serverUrl: item.serverUrl,
            operationId: item.operationId,
            sequence: item.sequence,
            source: item.source,
            target: item.target,
            status: item.status,
            lineage: {
              ...(item.lineage.legacyOperationId === undefined
                ? {}
                : { legacyOperationId: item.lineage.legacyOperationId }),
              active: item.lineage.active,
              sourceWork: {
                id: item.lineage.sourceWork.id,
                identity: item.lineage.sourceWork.identity,
              },
              targetWork: {
                id: item.lineage.targetWork.id,
                identity: item.lineage.targetWork.identity,
              },
            },
            ...(item.error === undefined ? {} : { error: item.error }),
          })),
        };
      }

      if (command === "db_content_sync_read_incoming_migrations") {
        const db = await selectDb(args.readMode as string | undefined);
        const serverUrl = normalizeContentServerUrl(args.serverUrl as string);
        const operationIds = args.operationIds as string[] | undefined;
        const includeCompleted = Boolean(args.includeCompleted);
        if (operationIds) {
          const rows: Array<{ cacheKey: string; payload: string }> = [];
          const seen = new Set<string>();
          for (const opId of operationIds) {
            const key = receiptKey(serverUrl, opId);
            if (seen.has(key)) continue;
            seen.add(key);
            const found = await db.select<{ cacheKey: string; payload: string }[]>(
              "SELECT cache_key AS cacheKey,payload FROM content_sync_cache WHERE cache_key=$1",
              [key],
            );
            if (found[0]) rows.push(found[0]);
          }
          return { handled: true, result: rows };
        }
        const prefix = serverReceiptPrefix(serverUrl);
        const allRows = await db.select<{ cacheKey: string; payload: string }[]>(
          "SELECT cache_key AS cacheKey,payload FROM content_sync_cache WHERE substr(cache_key,1,length($1))=$1 ORDER BY cache_key",
          [prefix],
        );
        const filtered: Array<{ cacheKey: string; payload: string }> = [];
        for (const row of allRows) {
          const parsed = parseStoredIncoming(row);
          if (
            includeCompleted ||
            (parsed.status !== "completed" && parsed.status !== "inactive")
          ) {
            filtered.push(row);
          }
        }
        return { handled: true, result: filtered };
      }

      if (command === "db_content_sync_save_incoming_migration") {
        const record =
          typeof args.recordJson === "string"
            ? (JSON.parse(args.recordJson) as IncomingMigration)
            : (args.record as IncomingMigration);
        await options.runTransaction((db) =>
          saveIncomingMigrationInTestDb(db, record),
        );
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_content_sync_get_incoming_migration_cursor") {
        const db = await selectDb(args.readMode as string | undefined);
        const cursor = await getIncomingMigrationCursorInTestDb(
          db,
          args.serverUrl as string,
        );
        return { handled: true, result: cursor };
      }

      if (command === "db_content_sync_save_incoming_migration_cursor") {
        await options.runTransaction((db) =>
          saveIncomingMigrationCursorInTestDb(
            db,
            args.serverUrl as string,
            args.cursor as number,
          ),
        );
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_content_sync_remember_incoming_migration_page") {
        const server = args.serverUrl as string;
        const items = Array.isArray(args.itemsJson)
          ? (args.itemsJson as string[]).map(
              (raw) => JSON.parse(raw) as WorkMigrationLineage,
            )
          : ((args.items ?? []) as WorkMigrationLineage[]);
        const cursor = args.cursor as number;
        await options.runTransaction(async (db) => {
          const serverUrl = normalizeContentServerUrl(server);
          const prefix = serverReceiptPrefix(serverUrl);
          const rows = await db.select<{ cacheKey: string; payload: string }[]>(
            "SELECT cache_key AS cacheKey,payload FROM content_sync_cache WHERE substr(cache_key,1,length($1))=$1 ORDER BY cache_key",
            [prefix],
          );
          const previous = new Map(
            rows
              .map(parseStoredIncoming)
              .map((record) => [record.operationId, record]),
          );
          const changedSources = new Set<string>();
          for (const entry of items) {
            const old = previous.get(entry.operationId);
            if (!old || entry.sequence > old.sequence) {
              changedSources.add(entry.sourceWork.id);
            }
            const record = incomingMigrationFromLineage(serverUrl, entry, old);
            const saved = await saveIncomingMigrationInTestDb(db, record);
            previous.set(entry.operationId, saved);
          }
          const successors = new Map<string, WorkMigrationLineage[]>();
          for (const value of previous.values()) {
            if (!value.lineage.active) continue;
            const edges = successors.get(value.lineage.sourceWork.id) ?? [];
            edges.push(value.lineage);
            successors.set(value.lineage.sourceWork.id, edges);
          }
          for (const record of previous.values()) {
            if (record.status !== "blocked") continue;
            const remaining = [record.lineage.targetWork.id];
            const visited = new Set<string>();
            let affected = false;
            while (remaining.length && !affected) {
              const id = remaining.pop()!;
              if (visited.has(id)) continue;
              visited.add(id);
              if (changedSources.has(id)) affected = true;
              for (const edge of successors.get(id) ?? []) {
                remaining.push(edge.targetWork.id);
              }
            }
            if (affected) {
              await saveIncomingMigrationInTestDb(db, {
                ...record,
                status: "pending",
                error: undefined,
              });
            }
          }
          await saveIncomingMigrationCursorInTestDb(db, serverUrl, cursor);
        });
        return {
          handled: true,
          result: { value: null, effects: {} } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_content_deletion_list_stored_novel_ids") {
        const db = await selectDb(args.readMode as string | undefined);
        const rows = await db.select<{ id: number }[]>(
          `SELECT n.id FROM novel n WHERE n.is_local=0 AND EXISTS(
            SELECT 1 FROM chapter c WHERE c.novel_id=n.id AND (c.is_downloaded=1 OR c.media_repair_needed=1))`,
        );
        return { handled: true, result: rows.map((row) => row.id) };
      }

      if (command === "db_content_deletion_list_downloaded_chapter_ids") {
        const db = await selectDb(args.readMode as string | undefined);
        const stored =
          "SELECT c.id FROM chapter c JOIN novel n ON n.id=c.novel_id WHERE n.is_local=0 AND (c.is_downloaded=1 OR c.content_bytes>0 OR c.media_repair_needed=1)";
        const novelIds = (args.novelIds ?? null) as number[] | null;
        if (!novelIds) {
          const rows = await db.select<{ id: number }[]>(
            `${stored} ORDER BY c.id`,
          );
          return { handled: true, result: rows.map((row) => row.id) };
        }
        const unique = [...new Set(novelIds)];
        const ids: number[] = [];
        for (let index = 0; index < unique.length; index += 500) {
          const chunk = unique.slice(index, index + 500);
          const rows = await db.select<{ id: number }[]>(
            `${stored} AND c.novel_id IN (${chunk.map((_, offset) => `$${offset + 1}`).join(",")})`,
            chunk,
          );
          ids.push(...rows.map((row) => row.id));
        }
        return {
          handled: true,
          result: ids.sort((left, right) => left - right),
        };
      }

      if (command === "db_content_deletion_find_local_novel") {
        const db = await selectDb(args.readMode as string | undefined);
        const [row] = await db.select<Array<Record<string, unknown>>>(
          `SELECT n.id, n.source_novel_id AS sourceNovelId, n.plugin_id AS pluginId, ip.name AS pluginName,
                  n.path, n.name, n.cover, n.summary, n.author, n.artist, n.status, n.genres, n.rating,
                  n.in_library AS inLibrary, n.is_local AS isLocal, n.created_at AS createdAt,
                  n.updated_at AS updatedAt, n.library_added_at AS libraryAddedAt, n.last_read_at AS lastReadAt
           FROM novel n LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id
           WHERE n.plugin_id = $1 AND n.source_novel_id = $2`,
          [args.pluginId, args.sourceNovelId],
        );
        return {
          handled: true,
          result: row
            ? {
                ...row,
                inLibrary: Boolean(row.inLibrary),
                isLocal: row.pluginId === "local" && Boolean(row.isLocal),
                statusOverride: await statusOverrideInDb(db, row.id),
                coverOverride: await coverOverrideInDb(db, row.id),
              }
            : null,
        };
      }

      if (command === "db_content_deletion_delete_novel_records") {
        const input = args.input as {
          id: number;
          pluginId: string;
          sourceNovelId: string | null;
          path: string;
          recordUserStateRemoval?: boolean;
        };
        const effects: DbMutationEffects = {};
        await options.runTransaction(async (db) => {
          const [current] = await db.select<
            {
              pluginId: string;
              sourceNovelId: string | null;
              path: string;
              name: string;
              inLibrary: number;
              lastReadAt: number | null;
            }[]
          >(
            "SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path,name,in_library AS inLibrary,last_read_at AS lastReadAt FROM novel WHERE id=$1",
            [input.id],
          );
          if (!current) return;
          if (
            current.pluginId !== input.pluginId ||
            current.sourceNovelId !== input.sourceNovelId ||
            current.path !== input.path
          ) {
            throw new Error("Local work identity changed before deletion.");
          }
          if (input.recordUserStateRemoval && (await hasUserStateSchema(db))) {
            let recordedAny = false;
            const work = {
              pluginId: current.pluginId,
              sourceNovelId: current.sourceNovelId,
              novelPath: current.path,
              name: current.name,
            };
            const categories = await db.select<{ id: number }[]>(
              "SELECT category_id AS id FROM novel_category WHERE novel_id=$1",
              [input.id],
            );
            for (const category of categories) {
              await recordMembershipInDb(db, [input.id], category.id, false);
              recordedAny = true;
            }
            const resumeKey = userStateEntityKey({ kind: "resume", work });
            const [hasResumeState] =
              current.lastReadAt !== null
                ? [{ present: 1 }]
                : await db.select<{ present: number }[]>(
                    "SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM user_state_intent WHERE entity_key=$1) OR EXISTS(SELECT 1 FROM user_state_record WHERE entity_key=$1) OR EXISTS(SELECT 1 FROM work_metadata_reading_state WHERE plugin_id=$2 AND novel_path=$3)",
                    [resumeKey, current.pluginId, current.path],
                  );
            if (hasResumeState) {
              await recordResumeClearedInDb(db, [input.id]);
              recordedAny = true;
            }
            const chapters = await db.select<UserChapterRow[]>(
              USER_CHAPTER_SELECT +
                " WHERE c.novel_id=$1 AND (c.progress>0 OR c.unread=0 OR c.read_at IS NOT NULL OR c.bookmark=1)",
              [input.id],
            );
            if (chapters.length) {
              const privateKeys = new Set(
                (
                  await db.select<{ entityKey: string }[]>(
                    "SELECT entity_key AS entityKey FROM user_state_private",
                  )
                ).map((row) => row.entityKey),
              );
              const readingResets = chapters
                .filter(
                  (row) =>
                    (row.progress > 0 ||
                      row.unread === 0 ||
                      row.readAt !== null) &&
                    !privateKeys.has(
                      userStateEntityKey({
                        kind: "reading",
                        work: chapterWork(row),
                        chapter: chapterReference(row),
                      }),
                    ),
                )
                .map((row) => ({ ...row, progress: 0, unread: 1, readAt: null }));
              if (readingResets.length) {
                await recordChapterRowsInDb(db, readingResets, "reading");
                recordedAny = true;
              }
              const bookmarkResets = chapters
                .filter((row) => sqliteBoolean(row.bookmark))
                .map((row) => ({ ...row, bookmark: 0 }));
              if (bookmarkResets.length) {
                await recordChapterRowsInDb(db, bookmarkResets, "bookmark");
                recordedAny = true;
              }
            }
            if (recordedAny) {
              effects.userStateLedgerChanged = true;
              effects.userStatePriority = "normal";
            }
          }
          const chapterRows = await db.select<{ id: number }[]>(
            "SELECT id FROM chapter WHERE novel_id=$1",
            [input.id],
          );
          await db.execute(
            "DELETE FROM content_sync_cache WHERE cache_key IN (SELECT 'norea-content-chapter-source:' || id FROM chapter WHERE novel_id=$1)",
            [input.id],
          );
          await db.execute("DELETE FROM novel WHERE id=$1", [input.id]);
          if (current.pluginId !== "local" && (await hasUserStateSchema(db))) {
            await db.execute(
              `UPDATE user_state_record
               SET deferred_reason='missing-work',deferred_detail=NULL
               WHERE applied_revision>=revision AND deferred_reason IS NULL
                 AND COALESCE(json_extract(payload,'$.entity.kind'),'')<>'library'
                 AND json_extract(payload,'$.entity.work.pluginId')=$1
                 AND (json_extract(payload,'$.entity.work.novelPath')=$3
                   OR ($2 IS NOT NULL AND lower(json_extract(payload,'$.entity.work.sourceNovelId'))=lower($2)))`,
              [current.pluginId, current.sourceNovelId, current.path],
            );
          }
          await db.execute(
            "DELETE FROM work_metadata_reading_state WHERE plugin_id=$1 AND novel_path=$2",
            [input.pluginId, input.path],
          );
          await db.execute(
            "DELETE FROM content_sync_cache WHERE cache_key=$1",
            [`norea-content-source:${input.id}`],
          );
          effects.workDirectories = [
            {
              novelId: input.id,
              pluginId: input.pluginId,
              novelPath: input.path,
              directory: null,
              fingerprint: null,
            },
          ];
          effects.chapterDirectories = chapterRows.map((row) => ({
            chapterId: row.id,
            directory: null,
          }));
          effects.contentSyncMaxSequence = await readJournalSeq(db);
        });
        return {
          handled: true,
          result: { value: null, effects } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_content_deletion_verify_download_clear") {
        const input = args.input as {
          id: number;
          pluginId: string;
          sourceNovelId: string | null;
          path: string;
        };
        const db = await selectDb(args.readMode as string | undefined);
        const [before] = await db.select<
          {
            pluginId: string;
            sourceNovelId: string | null;
            path: string;
            isLocal: number;
          }[]
        >(
          "SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path,is_local AS isLocal FROM novel WHERE id=$1",
          [input.id],
        );
        if (!before) return { handled: true, result: false };
        if (
          before.pluginId !== input.pluginId ||
          before.sourceNovelId !== input.sourceNovelId ||
          before.path !== input.path ||
          before.isLocal
        ) {
          throw new Error(
            "Local work identity changed before download deletion.",
          );
        }
        return { handled: true, result: true };
      }

      if (command === "db_content_deletion_commit_download_clear") {
        const input = args.input as {
          id: number;
          pluginId: string;
          sourceNovelId: string | null;
          path: string;
        };
        const effects: DbMutationEffects = {};
        await options.runTransaction(async (db) => {
          const [current] = await db.select<
            {
              pluginId: string;
              sourceNovelId: string | null;
              path: string;
              isLocal: number;
            }[]
          >(
            "SELECT plugin_id AS pluginId,source_novel_id AS sourceNovelId,path,is_local AS isLocal FROM novel WHERE id=$1",
            [input.id],
          );
          if (!current) return;
          if (
            current.pluginId !== input.pluginId ||
            current.sourceNovelId !== input.sourceNovelId ||
            current.path !== input.path ||
            current.isLocal
          ) {
            throw new Error(
              "Local work identity changed during download deletion.",
            );
          }
          const chapterRows = await db.select<{ id: number }[]>(
            "SELECT id FROM chapter WHERE novel_id=$1",
            [input.id],
          );
          const [exclusionTable] = await db.select<{ name: string }[]>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='chapter_download_goal_exclusion'",
          );
          if (exclusionTable) {
            await db.execute(
              `INSERT INTO chapter_download_goal_exclusion (chapter_id, created_at)
               SELECT id, unixepoch() FROM chapter
               WHERE novel_id=$1
                 AND (is_downloaded=1 OR content_bytes>0 OR media_bytes>0 OR media_repair_needed=1)
               ON CONFLICT(chapter_id) DO NOTHING`,
              [input.id],
            );
          }
          await db.execute(
            `UPDATE chapter SET is_downloaded=0,content_bytes=0,media_bytes=0,media_repair_needed=0,
             media_bytes_checked_at=NULL,updated_at=unixepoch() WHERE novel_id=$1`,
            [input.id],
          );
          await db.execute(
            "DELETE FROM work_metadata_directory_cache WHERE novel_id=$1",
            [input.id],
          );
          for (const table of [
            "work_metadata_file_cache",
            "work_metadata_sync_journal",
            "work_metadata_dirty",
          ]) {
            await db.execute(
              `DELETE FROM ${table} WHERE plugin_id=$1 AND path=$2`,
              [input.pluginId, input.path],
            );
          }
          effects.workDirectories = [
            {
              novelId: input.id,
              pluginId: input.pluginId,
              novelPath: input.path,
              directory: null,
              fingerprint: null,
            },
          ];
          effects.chapterDirectories = chapterRows.map((row) => ({
            chapterId: row.id,
            directory: null,
          }));
          effects.contentSyncMaxSequence = await readJournalSeq(db);
        }, false);
        return {
          handled: true,
          result: { value: null, effects } satisfies DbMutationEnvelope<null>,
        };
      }

      if (command === "db_content_deletion_list_novel_chapter_ids") {
        const db = await selectDb(args.readMode as string | undefined);
        const rows = await db.select<{ id: number }[]>(
          "SELECT id FROM chapter WHERE novel_id=$1",
          [args.novelId],
        );
        return { handled: true, result: rows.map((row) => row.id) };
      }

      return { handled: false };
    },
  };
}
