import type Database from "@tauri-apps/plugin-sql";
import { runDatabaseTransaction } from "../../db/client";
import { readWorkMetadataSyncFile } from "../../db/work-metadata";
import { hasStoredChapterContent, listChaptersByNovel, upsertSourceChaptersInDb, type ChapterListRow, type InsertChapterInput } from "../../db/queries/chapter";
import { findNovelBySource, type NovelDetailRecord } from "../../db/queries/novel";
import { canonicalMetadataValue, MAX_NOVEL_COVER_BYTES, parseNovelMetadata } from "../work-metadata/schema";
import { installStoredNovelMetadata, readStoredNovelCover, readStoredNovelMetadata, type InstalledNovelMetadata } from "../work-metadata";
import { inspectChapterPayloadInventory } from "../chapter-content/storage-platform";
import { compareChapterInventories, isChapterPayloadInventory, type ChapterPayloadInventory, type ChapterPayloadSnapshot } from "../chapter-content/inventory";
import { executeNovelMergeFromServer, type NovelMergeChapterDecision, type NovelMergeResult } from "../novel-merge";
import { cancelNovelChapterDownloadWork } from "../tasks/download-cache-delete";
import { ContentServerError, contentServerFetch, contentServerRequest, normalizeContentServerUrl, withContentServerLookup } from "./client";
import type { CatalogEntry } from "./native";
import type { MigrationLineageChapterDecision, MigrationLineageMapping, MigrationLineageWork, WorkMigrationLineage } from "./migration-feed-state";
import type { WorkMigrationSnapshot } from "./novel-migration-types";
import { rememberServerNovelSource } from "./novel-source";
import { contentWorkId, recordInstalledWorkMetadata } from "./works";

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
  recordIncomingMigration: (db: Database, targetPrepared?: boolean) => Promise<void>;
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

function matchesApprovedInventory(left: ChapterPayloadInventory, right: ChapterPayloadInventory): boolean {
  if (!isChapterPayloadInventory(left) || !isChapterPayloadInventory(right)) return false;
  if (left.expectedAssetKeys === null && right.expectedAssetKeys === null && !left.storedAssets.length && !right.storedAssets.length) return canonical(left.body) === canonical(right.body);
  const comparison = compareChapterInventories(left, right);
  return comparison.containsLocal && comparison.coverageEligible;
}

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

async function targetCover(server: string, token: string, target: WorkMigrationSnapshot, signal: AbortSignal): Promise<Uint8Array | undefined> {
  if (!target.work.metadata!.cover) return undefined;
  return withContentServerLookup(async deadline => {
    const response = await contentServerFetch(`${normalizeContentServerUrl(server)}/api/v1/works/${encodeURIComponent(target.work.id)}/cover`, {
      headers: { Authorization: `Bearer ${token}` }, maxRedirections: 0, connectTimeout: 10_000, signal: deadline,
    });
    if (!response.ok) throw new ContentServerError(response.status);
    if (Number(response.headers.get("content-length")) > MAX_NOVEL_COVER_BYTES) review("The target cover exceeds the allowed size.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_NOVEL_COVER_BYTES) review("The latest target cover is unavailable.");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    if (digest !== target.work.coverSha256) review("The target cover changed while it was being received.");
    return bytes;
  }, 30, signal);
}

async function serverChapter(server: string, token: string, novel: NovelDetailRecord, chapter: ChapterListRow, signal: AbortSignal): Promise<CatalogEntry | null> {
  const query = new URLSearchParams({ pluginId: novel.pluginId, novelPath: novel.path, chapterPath: chapter.path,
    ...(chapter.chapterNumber !== null ? { chapterNumber: chapter.chapterNumber } : {}),
  });
  let entry: CatalogEntry;
  try { entry = await contentServerRequest<CatalogEntry>(server, `/catalog/chapter?${query}`, token, "GET", undefined, signal); }
  catch (error) { if (error instanceof ContentServerError && error.status === 404) return null; throw error; }
  const identity = entry?.manifest?.identity;
  if (entry.deleted || !entry.complete || !entry.id || !entry.revision || identity?.pluginId !== novel.pluginId
    || identity.novelId !== novel.sourceNovelId || identity.novelPath !== novel.path
    || (identity.chapterPath !== chapter.path && numberKey(entry.manifest.chapter.chapterNumber) !== numberKey(chapter.chapterNumber))) review("The server target chapter does not match the received decision.");
  return entry;
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
    await runDatabaseTransaction(db => options.recordIncomingMigration(db, false));
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
  const cover = await targetCover(server, token, live, signal);
  await check();
  await installStoredNovelMetadata(live.work.metadata, cover, undefined, { authoritative: true });
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
  await runDatabaseTransaction(db => upsertSourceChaptersInDb(db, [...chapterInputs.values()]), true);
  await rememberServerNovelSource(target.id, { serverUrl: server, workId: resolved.targetWork.id });
  const targets = new Map((await listChaptersByNovel(target.id)).map(chapter => [chapter.path, chapter]));
  const decisions: NovelMergeChapterDecision[] = [];
  const expectedTargetInventories: Record<string, ChapterPayloadInventory | null> = {};
  for (const { chapter, decision } of plan) {
    await check();
    if (decision.targetChapterPath === null) { decisions.push({ sourceChapterId: chapter.id, kind: "exclude" }); continue; }
    const destination = targets.get(decision.targetChapterPath);
    if (!destination || numberKey(destination.chapterNumber) !== numberKey(decision.targetChapterNumber)) review("The recipient target chapter changed during preparation.");
    decisions.push({ sourceChapterId: chapter.id, kind: "map", targetChapterPath: destination.path });
    const mapping = targetMapping(decision, resolved.targetMappings);
    if (!hasStoredChapterContent(chapter) && !hasStoredChapterContent(destination)) continue;
    const inspectTarget = () => inspectChapterPayloadInventory({ novel: target, chapter: destination }, signal);
    const existing = await inspectTarget();
    const original: ChapterPayloadSnapshot | null = hasStoredChapterContent(chapter) ? await inspectChapterPayloadInventory({ novel: source, chapter }, signal) : null;
    let expected = mapping?.targetInventory;
    let entry: CatalogEntry | null | undefined;
    if (!expected) {
      entry = await serverChapter(server, token, target, destination, signal);
      if (!entry) {
        if (existing.body) review("The recipient target has unverified content that would conflict with the moved chapter.");
        expectedTargetInventories[destination.path] = null;
        continue;
      }
      // Another recipient may already have published its explicitly mapped, previously serverless body.
      const proof = await contentServerRequest<{ revision: string; identity: CatalogEntry["manifest"]["identity"]; inventory: ChapterPayloadInventory }>(server,
        `/chapters/${encodeURIComponent(entry.id)}/storage-inventory?revision=${encodeURIComponent(entry.revision)}`, token, "GET", undefined, signal);
      if (proof.revision !== entry.revision || canonical(proof.identity) !== canonical(entry.manifest.identity) || !isChapterPayloadInventory(proof.inventory) || !proof.inventory.body) review("The newly published target content cannot be verified.");
      expected = proof.inventory;
      if ((!original?.body || !matchesApprovedInventory(original, expected)) && (!existing.body || !matchesApprovedInventory(existing, expected))) review("The newly published target content differs from this recipient's copy.");
    }
    expectedTargetInventories[destination.path] = expected;
    if (existing.body) {
      if (!matchesApprovedInventory(existing, expected)) review("The recipient target download conflicts with the approved server content.");
      continue;
    }
    if (original?.body && matchesApprovedInventory(original, expected)) continue;
    entry ??= await serverChapter(server, token, target, destination, signal);
    if (!entry || mapping && (entry.id !== mapping.target.id || entry.revision !== mapping.target.revision)) review("The approved target body changed or is no longer available on the server.");
    const { downloadServerChapterFromServer } = await import("./sync");
    await downloadServerChapterFromServer(entry, server, { token, target: { pluginId: target.pluginId, novelPath: target.path, chapterPath: destination.path }, signal,
      beforeInstall: async () => { await check(); const current = await inspectTarget(); if (current.body && !matchesApprovedInventory(current, expected!)) review("A new recipient target download appeared during transfer."); },
    });
    const received = await inspectTarget();
    if (!received.mediaComplete || !matchesApprovedInventory(received, expected)) review("The received body does not match the approved target inventory.");
  }
  await check();
  const result = await executeNovelMergeFromServer({ sourceNovelId: source.id, targetNovelId: target.id, decisions }, {
    signal, expectedTargetInventories,
    beforeCommit: async () => {
      await check();
      await options.beforeCommit?.();
      await check();
      const latest = await currentTarget(server, token, resolved, signal);
      if (latest.work.revision !== live.work.revision) {
        throw new IncomingNovelMigrationRetryableError("The target changed before this recipient's migration could commit. The original work was retained.");
      }
      await check();
    },
    recordIncomingMigration: db => options.recordIncomingMigration(db, true),
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
