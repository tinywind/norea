import { isAbortError } from "../abort";
import { readWorkMetadataSyncFile } from "../../db/work-metadata";
import { isNovelMigrationSourceHeld, readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { listChaptersByNovel, upsertSourceChapters, type ChapterListRow, type InsertChapterInput } from "../../db/queries/chapter";
import { completeIncomingNovelMigration, type IncomingMigrationCommit } from "../../db/queries/novel-merge";
import { findNovelBySource } from "../../db/queries/novel";
import { canonicalMetadataValue, parseNovelMetadata } from "../work-metadata/schema";
import { installStoredNovelMetadata, persistNovelCover, readStoredNovelCover, readStoredNovelMetadata, type InstalledNovelMetadata } from "../work-metadata";
import { executeNovelMergeFromServer, type NovelMergeChapterDecision, type NovelMergeResult } from "../novel-merge";
import { cancelNovelChapterDownloadWork } from "../tasks/download-cache-delete";
import { readServerCover } from "./browse";
import { ContentServerError, contentServerRequest, normalizeContentServerUrl } from "./client";
import { serverWorkDeletionKey, waitForServerWorkDeletion, withServerWorkDeletionExclusions } from "./deletion-exclusions";
import type { IncomingMigration, MigrationLineageChapterDecision, MigrationLineageMapping, MigrationLineageWork, WorkMigrationLineage } from "./migration-feed-state";
import type { WorkMigrationSnapshot } from "./novel-migration-types";
import { rememberServerNovelSource } from "./novel-source";
import { canPullWorkMetadata, contentWorkId, recordInstalledWorkMetadata, runWorkMetadataSyncOperation, workMetadataFingerprint, type WorkCatalogEntry } from "./works";

export interface ResolvedIncomingNovelMigration {
  sourceWork: MigrationLineageWork;
  targetWork: MigrationLineageWork;
  chapterDecisions: MigrationLineageChapterDecision[];
  targetMappings: MigrationLineageMapping[];
  chain: WorkMigrationLineage[];
}

export interface IncomingNovelMigrationResult extends NovelMergeResult { sourceNovelId: number; installedTargetMetadata?: InstalledNovelMetadata }

export interface IncomingNovelMigrationOptions {
  signal?: AbortSignal;
  assertCurrent: () => void | Promise<void>;
  beforeCommit?: () => Promise<void>;
  incomingMigrationCommit: Omit<IncomingMigrationCommit, "releaseTargetWork">;
}

export class IncomingNovelMigrationReviewRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "IncomingNovelMigrationReviewRequiredError"; }
}

export class IncomingNovelMigrationRetryableError extends Error {
  readonly code = "incoming-novel-migration-changed";
  constructor(message: string) { super(message); this.name = "IncomingNovelMigrationRetryableError"; }
}

function review(message: string): never { throw new IncomingNovelMigrationReviewRequiredError(message + " The original work was retained."); }
const canonical = (value: unknown) => JSON.stringify(canonicalMetadataValue(value));
const numberKey = (value: string | null | undefined) => value != null && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? String(Number(value)) : null;
const sameIdentity = (left: MigrationLineageWork["identity"], right: MigrationLineageWork["identity"]) => canonical(left) === canonical(right);

function decisionFor(chapter: ChapterListRow, decisions: readonly MigrationLineageChapterDecision[]): MigrationLineageChapterDecision | undefined {
  const exact = decisions.filter(value => value.sourceChapterPath === chapter.path);
  if (exact.length === 1) {
    if (exact[0]!.sourceChapterNumber !== null && numberKey(exact[0]!.sourceChapterNumber) !== numberKey(chapter.chapterNumber)) review("The recipient source chapter number changed.");
    return exact[0];
  }
  if (exact.length) return review("The received migration repeats a source chapter.");
  const number = numberKey(chapter.chapterNumber);
  if (number === null) return undefined;
  const matches = decisions.filter(value => value.sourceMetadataVerified && numberKey(value.sourceChapterNumber) === number);
  return matches.length === 1 ? matches[0] : undefined;
}

function targetMapping(decision: MigrationLineageChapterDecision, mappings: readonly MigrationLineageMapping[]): Exclude<MigrationLineageMapping, { decision: "delete-source" }> | undefined {
  const candidates = mappings.filter((mapping): mapping is Exclude<MigrationLineageMapping, { decision: "delete-source" }> => mapping.target !== null);
  const exact = candidates.filter(value => value.target.chapterPath === decision.targetChapterPath);
  if (exact.length > 1) return review("The received migration repeats a target chapter.");
  if (exact.length) {
    if (numberKey(exact[0]!.target.chapterNumber) !== numberKey(decision.targetChapterNumber)) review("The received target path and number disagree.");
    return exact[0];
  }
  const number = numberKey(decision.targetChapterNumber);
  if (number === null) return undefined;
  const matches = candidates.filter(value => numberKey(value.target.chapterNumber) === number);
  if (matches.length > 1) return review("The received target chapter number is ambiguous.");
  return matches[0];
}

async function currentTarget(server: string, token: string, resolved: ResolvedIncomingNovelMigration, signal: AbortSignal): Promise<WorkMigrationSnapshot & { work: { metadata: NonNullable<WorkMigrationSnapshot["work"]["metadata"]> } }> {
  const target = await contentServerRequest<WorkMigrationSnapshot>(server, `/works/${resolved.targetWork.id}/migration-snapshot`, token, "GET", undefined, signal);
  const metadata = parseNovelMetadata(target.work?.metadata);
  if (target.work?.id !== resolved.targetWork.id || await contentWorkId(metadata.identity) !== target.work.id || !target.work.revision || !sameIdentity(target.work.identity, resolved.targetWork.identity)
    || !sameIdentity(metadata.identity, resolved.targetWork.identity) || metadata.novel.isLocal || !Array.isArray(target.chapters)
    || (metadata.cover === null ? target.work.coverSha256 !== null : typeof target.work.coverSha256 !== "string" || !/^[a-f0-9]{64}$/.test(target.work.coverSha256))) review("The latest server target metadata cannot be verified.");
  for (const decision of resolved.chapterDecisions) {
    if (decision.targetChapterPath === null) continue;
    const exact = target.chapters.filter(chapter => chapter.chapterPath === decision.targetChapterPath);
    const number = numberKey(decision.targetChapterNumber);
    if (exact.length > 1 || exact.length && numberKey(exact[0]!.chapterNumber) !== number) review("The latest target chapter identity changed.");
    const numbered = number === null ? [] : target.chapters.filter(chapter => numberKey(chapter.chapterNumber) === number);
    if (!exact.length && numbered.length > 1) review("The latest target chapter number is ambiguous.");
    if (!exact.length && !numbered.length && (number === null || !Object.hasOwn(metadata.chapters, number))) review("A selected chapter disappeared from the latest target catalog.");
  }
  return { ...target, work: { ...target.work, metadata } };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function resolveTargetCoverBytes(
  server: string,
  token: string,
  workId: string,
  live: Awaited<ReturnType<typeof currentTarget>>,
  hasExistingTarget: boolean,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const expectedCover = live.work.metadata.cover;
  const expectedDigest = live.work.coverSha256;
  if (!expectedCover || !expectedDigest) return undefined;
  if (hasExistingTarget) {
    const existingSync = await readWorkMetadataSyncFile(live.work.metadata.identity);
    const existingStored = existingSync ? await readStoredNovelMetadata(existingSync.directory) : null;
    const existingBytes = existingStored?.metadata.cover
      ? await readStoredNovelCover(existingStored.directory, existingStored.metadata)
      : null;
    if (
      existingBytes?.length &&
      existingStored?.metadata.cover?.fileName === expectedCover.fileName &&
      existingStored.metadata.cover.contentType === expectedCover.contentType &&
      await sha256Hex(existingBytes) === expectedDigest
    ) {
      return existingBytes;
    }
  }
  let downloaded: { bytes: Uint8Array; contentType: string };
  try {
    downloaded = await readServerCover(server, token, workId, signal);
  } catch (error) {
    if (error instanceof ContentServerError && error.status === 404) {
      throw new IncomingNovelMigrationRetryableError("The target cover changed before this recipient's migration could commit. The original work was retained.");
    }
    throw error;
  }
  if (await sha256Hex(downloaded.bytes) !== expectedDigest) {
    throw new IncomingNovelMigrationRetryableError("The target cover changed before this recipient's migration could commit. The original work was retained.");
  }
  return downloaded.bytes;
}

const COVER_REPAIR_CACHE_PREFIX = "norea-content-incoming-cover-repair:v1:";

/** Backfill missing local covers for targets migrated before incoming replay fetched server covers. */
export async function repairCompletedIncomingMigrationCovers(
  serverUrl: string,
  token: string,
  records: readonly IncomingMigration[],
  assertCurrent: () => void = () => undefined,
  signal = new AbortController().signal,
): Promise<number> {
  const completed = records.filter(record => record.status === "completed" && record.lineage.active);
  if (!completed.length) return 0;
  const server = normalizeContentServerUrl(serverUrl);
  const cacheKey = `${COVER_REPAIR_CACHE_PREFIX}${server}`;
  const rawCache = await readContentSyncCache(cacheKey);
  let checkedSet = new Set<string>();
  if (rawCache) {
    try {
      const parsed = JSON.parse(rawCache) as { checked?: unknown };
      if (Array.isArray(parsed.checked)) {
        checkedSet = new Set(parsed.checked.filter((item): item is string => typeof item === "string" && item.length > 0));
      }
    } catch {
      checkedSet = new Set();
    }
  }
  const unchecked = completed.filter(record => !checkedSet.has(record.operationId));
  if (!unchecked.length) return 0;

  const supersededSourceIds = new Set(records.filter(record => record.lineage.active).map(record => record.lineage.sourceWork.id));
  const byTargetId = new Map<string, IncomingMigration[]>();
  for (const record of unchecked) {
    const group = byTargetId.get(record.lineage.targetWork.id) ?? [];
    group.push(record);
    byTargetId.set(record.lineage.targetWork.id, group);
  }

  return runWorkMetadataSyncOperation(server, () => withServerWorkDeletionExclusions(server, async excluded => {
    let repaired = 0;
    let dirty = false;
    const markChecked = (group: readonly IncomingMigration[]) => {
      for (const item of group) checkedSet.add(item.operationId);
      dirty = true;
    };
    try {
      for (const [targetId, group] of byTargetId) {
        signal.throwIfAborted();
        assertCurrent();
        if (supersededSourceIds.has(targetId)) {
          markChecked(group);
          continue;
        }
        const identity = group[0]!.lineage.targetWork.identity;
        try {
          const syncFile = await readWorkMetadataSyncFile(identity);
          if (!syncFile) {
            markChecked(group);
            continue;
          }
          if (excluded.has(serverWorkDeletionKey(identity)) || await isNovelMigrationSourceHeld(server, identity)) continue;
          const stored = await readStoredNovelMetadata(syncFile.directory);
          if (!stored) {
            markChecked(group);
            continue;
          }
          const existingCover = await readStoredNovelCover(stored.directory, stored.metadata);
          if (existingCover?.length) {
            markChecked(group);
            continue;
          }
          const wasSynced = await canPullWorkMetadata(server, syncFile, await workMetadataFingerprint(stored.metadata, null));
          let entry: WorkCatalogEntry;
          try {
            entry = await contentServerRequest<WorkCatalogEntry>(server, `/works/${encodeURIComponent(targetId)}`, token, "GET", undefined, signal);
          } catch (error) {
            if (error instanceof ContentServerError && error.status === 404) {
              markChecked(group);
              continue;
            }
            throw error;
          }
          signal.throwIfAborted();
          assertCurrent();
          if (entry.deleted || !entry.hasCover) {
            markChecked(group);
            continue;
          }
          const remoteMetadata = parseNovelMetadata(entry.metadata);
          if (!remoteMetadata.cover || entry.id !== targetId || await contentWorkId(remoteMetadata.identity) !== targetId || !sameIdentity(remoteMetadata.identity, identity)) {
            markChecked(group);
            continue;
          }
          const remoteCover = await readServerCover(server, token, targetId, signal);
          signal.throwIfAborted();
          assertCurrent();
          await waitForServerWorkDeletion(server, targetId);
          if (excluded.has(serverWorkDeletionKey(identity))) continue;
          await persistNovelCover(
            stored.directory,
            {
              body: remoteCover.bytes,
              fileName: remoteMetadata.cover.fileName,
              contentType: remoteMetadata.cover.contentType,
            },
            { preserveExisting: true },
          );
          if (wasSynced) {
            const updatedSync = await readWorkMetadataSyncFile(identity);
            const updatedStored = updatedSync && await readStoredNovelMetadata(updatedSync.directory);
            const updatedCover = updatedStored && await readStoredNovelCover(updatedStored.directory, updatedStored.metadata);
            if (updatedSync && updatedStored && updatedCover?.length) {
              await recordInstalledWorkMetadata(server, { ...updatedStored, syncFile: updatedSync, coverBytes: updatedCover }, true);
            }
          }
          repaired += 1;
          markChecked(group);
        } catch (error) {
          if (isAbortError(error) || (error instanceof ContentServerError && (error.status === 401 || error.status === 403))) throw error;
          signal.throwIfAborted();
          assertCurrent();
          console.warn("[incoming-migration] target cover backfill deferred", error);
        }
      }
    } finally {
      if (dirty) {
        await writeContentSyncCache(cacheKey, JSON.stringify({ checked: [...checkedSet] }));
      }
    }
    return repaired;
  }), signal);
}

/** Replay the confirmed mapping locally without loading either source plugin. */
export async function applyIncomingNovelMigration(
  server: string, token: string, resolved: ResolvedIncomingNovelMigration, options: IncomingNovelMigrationOptions,
): Promise<IncomingNovelMigrationResult | null> {
  const signal = options.signal ?? new AbortController().signal;
  const check = async () => { signal.throwIfAborted(); await options.assertCurrent(); signal.throwIfAborted(); };
  await check();
  const source = await findNovelBySource(resolved.sourceWork.identity.pluginId, resolved.sourceWork.identity.novelPath);
  if (!source) {
    await check();
    await options.beforeCommit?.();
    await check();
    await completeIncomingNovelMigration(options.incomingMigrationCommit);
    return null;
  }
  if (source.isLocal || source.sourceNovelId !== resolved.sourceWork.identity.novelId) review("The recipient source identity changed.");
  const previousTarget = await findNovelBySource(resolved.targetWork.identity.pluginId, resolved.targetWork.identity.novelPath);
  await cancelNovelChapterDownloadWork([source.id, ...(previousTarget ? [previousTarget.id] : [])]);
  await check();
  const sourceChapters = await listChaptersByNovel(source.id);
  const usedDecisions = new Set<MigrationLineageChapterDecision>();
  const plan = sourceChapters.map(chapter => {
    const decision = decisionFor(chapter, resolved.chapterDecisions);
    if (!decision || usedDecisions.has(decision)) return review("A recipient chapter has no unambiguous approved migration decision.");
    usedDecisions.add(decision);
    return { chapter, decision };
  });
  const live = await currentTarget(server, token, resolved, signal);
  await check();
  const targetCoverBytes = await resolveTargetCoverBytes(server, token, resolved.targetWork.id, live, previousTarget !== null, signal);
  await check();
  await installStoredNovelMetadata(live.work.metadata, targetCoverBytes, undefined, { authoritative: true });
  const target = await findNovelBySource(resolved.targetWork.identity.pluginId, resolved.targetWork.identity.novelPath);
  if (!target || target.isLocal || target.sourceNovelId !== resolved.targetWork.identity.novelId) review("The recipient target identity could not be prepared.");
  const positions = new Map(Object.keys(live.work.metadata.chapters).sort((a, b) => Number(a) - Number(b)).map((number, index) => [number, index + 1]));
  const chapterInputs = new Map<string, InsertChapterInput>();
  for (const decision of resolved.chapterDecisions) {
    if (decision.targetChapterPath === null) continue;
    const mapping = targetMapping(decision, resolved.targetMappings);
    const number = numberKey(decision.targetChapterNumber);
    const name = number === null ? mapping?.target.name : live.work.metadata.chapters[number] ?? mapping?.target.name;
    if (!name) review("The received target chapter has no source metadata.");
    chapterInputs.set(decision.targetChapterPath, { novelId: target.id, path: decision.targetChapterPath, chapterNumber: decision.targetChapterNumber,
      name, position: number !== null && positions.has(number) ? positions.get(number)! : mapping!.target.position, page: "1" });
  }
  if (!live.work.metadata.chapterComposition) await upsertSourceChapters([...chapterInputs.values()], { remoteContentSync: true });
  await rememberServerNovelSource(target.id, { serverUrl: server, workId: resolved.targetWork.id });
  const targets = new Map((await listChaptersByNovel(target.id)).map(chapter => [chapter.path, chapter]));
  const decisions: NovelMergeChapterDecision[] = [];
  const skipSourceContentChapterIds: number[] = [];
  for (const { chapter, decision } of plan) {
    await check();
    if (decision.targetChapterPath === null) { decisions.push({ sourceChapterId: chapter.id, kind: "exclude" }); continue; }
    const destination = targets.get(decision.targetChapterPath);
    if (!destination || numberKey(destination.chapterNumber) !== numberKey(decision.targetChapterNumber)) review("The recipient target chapter changed during preparation.");
    decisions.push({ sourceChapterId: chapter.id, kind: "map", targetChapterPath: destination.path });
    if (decision.discardSourceContent) skipSourceContentChapterIds.push(chapter.id);
  }
  await check();
  const result = await executeNovelMergeFromServer({ sourceNovelId: source.id, targetNovelId: target.id, decisions,
    ...(skipSourceContentChapterIds.length ? { skipSourceContentChapterIds } : {}),
  }, {
    signal,
    beforeCommit: async () => {
      await check();
      await options.beforeCommit?.();
      await check();
      const latest = await currentTarget(server, token, resolved, signal);
      if (latest.work.revision !== live.work.revision || latest.work.coverSha256 !== live.work.coverSha256) {
        throw new IncomingNovelMigrationRetryableError("The target changed before this recipient's migration could commit. The original work was retained.");
      }
      await check();
    },
    incomingMigrationCommit: {
      ...options.incomingMigrationCommit,
      releaseTargetWork: {
        workId: resolved.targetWork.id,
        pluginId: resolved.targetWork.identity.pluginId,
        novelPath: resolved.targetWork.identity.novelPath,
      },
    },
  });
  let installedTargetMetadata: InstalledNovelMetadata | undefined;
  try {
    const syncFile = await readWorkMetadataSyncFile(live.work.metadata.identity);
    const stored = syncFile && await readStoredNovelMetadata(syncFile.directory);
    if (!syncFile || !stored) throw new Error("The installed target metadata could not be indexed after migration.");
    installedTargetMetadata = { ...stored, syncFile, coverBytes: await readStoredNovelCover(stored.directory, stored.metadata) };
    await recordInstalledWorkMetadata(server, installedTargetMetadata, live.work.metadata.cover !== null);
    return { ...result, sourceNovelId: source.id, installedTargetMetadata };
  } catch (error) {
    return { ...result, sourceNovelId: source.id, ...(installedTargetMetadata ? { installedTargetMetadata } : {}), cleanupWarnings: [...result.cleanupWarnings,
      `The migration committed, but its metadata cache needs synchronization: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
