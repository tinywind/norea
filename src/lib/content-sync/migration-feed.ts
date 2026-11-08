import { runDatabaseTransaction } from "../../db/client";
import { isAbortError } from "../abort";
import { useReaderStore } from "../../store/reader";
import { recordInstalledWorkMetadata, releaseMigratedTargetMetadataInDb } from "./works";
import type { InstalledNovelMetadata } from "../work-metadata";
import { contentServerRequest, ContentServerError, ContentServerTransportError, normalizeContentServerUrl } from "./client";
import { publishNovelMigrationSourceHold } from "./deletion-exclusions";
import {
  getIncomingMigrationCursor, incomingMigrationFromLineage, listIncomingMigrations,
  parseWorkMigrationLineage, saveIncomingMigration, saveIncomingMigrationCursor,
  type IncomingMigration, type WorkMigrationLineage,
} from "./migration-feed-state";
import { applyIncomingNovelMigration, IncomingNovelMigrationRetryableError, type ResolvedIncomingNovelMigration } from "./incoming-novel-migration";

const PAGE_SIZE = 50;

export interface IncomingMigrationSyncResult { applied: number; pending: number; error?: string; retryable?: boolean }

export class PendingIncomingMigrationError extends Error {
  constructor(readonly count: number, reason?: string, readonly retryable = false) {
    super(`Received work migration is pending for ${count} work(s). Existing local data were retained.${reason ? ` ${reason}` : ""}`);
    this.name = "PendingIncomingMigrationError";
  }
}

/** Follow approved active edges before touching local files, including clients that missed several migrations. */
export function resolveIncomingNovelMigration(entry: WorkMigrationLineage, entries: readonly WorkMigrationLineage[]): ResolvedIncomingNovelMigration {
  if (!entry.active || !entry.fullDecisionCoverage) throw new Error("The received migration does not contain an active, complete chapter decision list.");
  const bySource = new Map<string, WorkMigrationLineage[]>();
  for (const value of entries) {
    if (!value.active) continue;
    const found = bySource.get(value.sourceWork.id) ?? [];
    if (!found.some(previous => previous.operationId === value.operationId)) found.push(value);
    bySource.set(value.sourceWork.id, found);
  }
  const chain = [entry];
  const seen = new Set([entry.sourceWork.id]);
  let targetWork = entry.targetWork;
  let chapterDecisions = entry.chapterDecisions.map(decision => ({ ...decision }));
  for (;;) {
    if (seen.has(targetWork.id)) throw new Error("The received work migration history contains a cycle.");
    seen.add(targetWork.id);
    const successors = bySource.get(targetWork.id) ?? [];
    if (successors.length > 1) throw new Error("The received work migration history has conflicting targets.");
    const successor = successors[0];
    if (!successor) break;
    if (!successor.fullDecisionCoverage) throw new Error("A later work migration does not contain the complete chapter decisions.");
    if (successor.sourceWork.identity.pluginId !== targetWork.identity.pluginId ||
      successor.sourceWork.identity.novelId !== targetWork.identity.novelId ||
      successor.sourceWork.identity.novelPath !== targetWork.identity.novelPath) {
      throw new Error("A later work migration changed its source identity.");
    }
    const byPath = new Map(successor.chapterDecisions.map(decision => [decision.sourceChapterPath, decision]));
    const byNumber = new Map<string, typeof successor.chapterDecisions>();
    for (const next of successor.chapterDecisions) {
      if (next.sourceChapterNumber === null) continue;
      const number = String(Number(next.sourceChapterNumber));
      const found = byNumber.get(number) ?? [];
      found.push(next); byNumber.set(number, found);
    }
    const previousEdge = chain.at(-1)!;
    chapterDecisions = chapterDecisions.map(decision => {
      if (decision.targetChapterPath === null) return decision;
      let next = byPath.get(decision.targetChapterPath);
      if (!next && decision.targetChapterNumber !== null) {
        const number = String(Number(decision.targetChapterNumber));
        const candidates = byNumber.get(number) ?? [];
        const candidate = candidates.length === 1 ? candidates[0] : undefined;
        const alias = decision.targetChapterPath.startsWith("norea-folder:") || candidate?.sourceChapterPath.startsWith("norea-folder:");
        const beforePayload = previousEdge.mappings.find(mapping => mapping.target &&
          (mapping.target.chapterPath === decision.targetChapterPath || (mapping.target.chapterNumber !== null && String(Number(mapping.target.chapterNumber)) === number)));
        const afterPayload = candidate && successor.mappings.find(mapping => mapping.source.chapterPath === candidate.sourceChapterPath ||
          (mapping.source.chapterNumber !== null && String(Number(mapping.source.chapterNumber)) === number));
        const stablePayload = !beforePayload || !afterPayload || beforePayload.target?.id === afterPayload.source.id;
        const stableMetadata = targetWork.metadata.chapters[number] !== undefined &&
          targetWork.metadata.chapters[number] === successor.sourceWork.metadata.chapters[number];
        if (candidate && alias && decision.targetMetadataVerified && candidate.sourceMetadataVerified && stableMetadata && stablePayload) next = candidate;
      }
      if (!next) throw new Error("A later work migration does not explain an earlier mapped chapter.");
      return { ...decision, targetChapterPath: next.targetChapterPath, targetChapterNumber: next.targetChapterNumber,
        discardSourceContent: next.targetChapterPath !== null && (decision.discardSourceContent || next.discardSourceContent) ? true : undefined,
        targetMetadataVerified: next.targetMetadataVerified };
    });
    chain.push(successor);
    targetWork = successor.targetWork;
  }
  return { sourceWork: entry.sourceWork, targetWork, chapterDecisions, targetMappings: chain.at(-1)!.mappings, chain };
}

function pageValue(value: unknown, after: number): { items: WorkMigrationLineage[]; cursor: number; hasMore: boolean } {
  if (!value || typeof value !== "object" || !("items" in value) || !Array.isArray(value.items) || value.items.length > PAGE_SIZE ||
    !("cursor" in value) || !Number.isSafeInteger(value.cursor) || Number(value.cursor) < after ||
    !("hasMore" in value) || typeof value.hasMore !== "boolean") throw new Error("Invalid work migration page.");
  const items = value.items.map(parseWorkMigrationLineage);
  let previous = after;
  for (const item of items) {
    if (item.sequence <= previous || item.sequence > Number(value.cursor)) throw new Error("Work migration events are out of order.");
    previous = item.sequence;
  }
  if (value.hasMore && (!items.length || Number(value.cursor) <= after)) throw new Error("Work migration pagination did not advance.");
  return { items, cursor: Number(value.cursor), hasMore: value.hasMore };
}

async function rememberPage(server: string, items: readonly WorkMigrationLineage[], cursor: number): Promise<void> {
  await runDatabaseTransaction(async db => {
    const previous = new Map((await listIncomingMigrations(server, true, db)).map(record => [record.operationId, record]));
    const changedSources = new Set<string>();
    for (const entry of items) {
      const old = previous.get(entry.operationId);
      if (!old || entry.sequence > old.sequence) changedSources.add(entry.sourceWork.id);
      const record = incomingMigrationFromLineage(server, entry, old);
      await saveIncomingMigration(record, db);
      previous.set(record.operationId, record);
    }
    // A later migration or revocation can resolve a previously blocked intermediate target.
    // Reconsider only predecessors reached by new evidence; unrelated review holds stay blocked.
    const successors = new Map<string, WorkMigrationLineage[]>();
    for (const value of previous.values()) {
      if (!value.lineage.active) continue;
      const edges = successors.get(value.lineage.sourceWork.id) ?? [];
      edges.push(value.lineage); successors.set(value.lineage.sourceWork.id, edges);
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
        for (const edge of successors.get(id) ?? []) remaining.push(edge.targetWork.id);
      }
      if (affected) await saveIncomingMigration({ ...record, status: "pending", error: undefined }, db);
    }
    await saveIncomingMigrationCursor(server, cursor, db);
  });
  for (const entry of items) if (entry.active) publishNovelMigrationSourceHold(server, entry.sourceWork.identity);
}

async function refreshReceivedMigration(server: string, token: string, record: IncomingMigration, assertCurrent: () => void, signal: AbortSignal): Promise<IncomingMigration> {
  signal.throwIfAborted(); assertCurrent();
  const value = await contentServerRequest<unknown>(server, `/work-migrations/${encodeURIComponent(record.operationId)}`, token, "GET", undefined, signal);
  signal.throwIfAborted(); assertCurrent();
  const entry = parseWorkMigrationLineage(value);
  if (entry.operationId !== record.operationId || entry.sequence < record.sequence) throw new Error("The current work migration history moved backwards.");
  const next = incomingMigrationFromLineage(server, entry, record);
  await saveIncomingMigration(next);
  return next;
}

/** Persist every source hold before ordinary metadata or body uploads can restore an old work. */
export async function syncIncomingNovelMigrations(
  serverUrl: string,
  token: string,
  assertCurrent: () => void = () => undefined,
  retryBlocked = true,
  signal = new AbortController().signal,
): Promise<IncomingMigrationSyncResult> {
  const server = normalizeContentServerUrl(serverUrl);
  signal.throwIfAborted(); assertCurrent();
  const capabilities = await contentServerRequest<{ workMigrationLineageVersion?: number }>(server, "/capabilities", token, "GET", undefined, signal);
  if (capabilities.workMigrationLineageVersion !== 1) throw new Error("Update the content server before synchronizing work migrations.");
  let cursor = await getIncomingMigrationCursor(server);
  for (;;) {
    signal.throwIfAborted(); assertCurrent();
    const raw = await contentServerRequest<unknown>(server, `/work-migrations?after=${cursor}&limit=${PAGE_SIZE}`, token, "GET", undefined, signal);
    const page = pageValue(raw, cursor);
    signal.throwIfAborted(); assertCurrent();
    await rememberPage(server, page.items, page.cursor);
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  let applied = 0;
  const installedTargets = new Map<string, InstalledNovelMetadata>();
  for (const saved of (await listIncomingMigrations(server)).sort((left, right) => left.sequence - right.sequence)) {
    if (saved.status === "blocked" && !retryBlocked) continue;
    let record = saved;
    try {
      record = await refreshReceivedMigration(server, token, record, assertCurrent, signal);
      if (record.status === "inactive" || record.status === "completed") continue;
      let resolved = resolveIncomingNovelMigration(record.lineage, (await listIncomingMigrations(server, true)).map(value => value.lineage));
      for (const edge of resolved.chain.slice(1)) {
        const next = (await listIncomingMigrations(server, true)).find(value => value.operationId === edge.operationId);
        if (!next) throw new Error("A later work migration is not saved locally.");
        await refreshReceivedMigration(server, token, next, assertCurrent, signal);
      }
      resolved = resolveIncomingNovelMigration(record.lineage, (await listIncomingMigrations(server, true)).map(value => value.lineage));
      record = { ...record, status: "pending", error: undefined };
      await saveIncomingMigration(record);
      const expected = record;
      const assertLineageCurrent = async () => {
        signal.throwIfAborted(); assertCurrent();
        for (const edge of resolved.chain) {
          const raw = await contentServerRequest<unknown>(server, `/work-migrations/${encodeURIComponent(edge.operationId)}`, token, "GET", undefined, signal);
          const current = parseWorkMigrationLineage(raw);
          if (!current.active || current.sequence !== edge.sequence || current.operationId !== edge.operationId) {
            throw new Error("The server changed this work migration while local data were being prepared.");
          }
          // HTTP validation must not query the serialized database while a caller owns a transaction.
          // The complete saved chain is checked again using the raw commit connection below.
          incomingMigrationFromLineage(server, current, incomingMigrationFromLineage(server, edge));
        }
        signal.throwIfAborted(); assertCurrent();
      };
      const result = await applyIncomingNovelMigration(server, token, resolved, {
        signal,
        assertCurrent: () => { signal.throwIfAborted(); assertCurrent(); },
        beforeCommit: assertLineageCurrent,
        recordIncomingMigration: async (db, targetPrepared = false) => {
          assertCurrent(); signal.throwIfAborted();
          const savedChain = new Map((await listIncomingMigrations(server, true, db)).map(value => [value.operationId, value]));
          for (const edge of resolved.chain) {
            const savedEdge = savedChain.get(edge.operationId);
            if (!savedEdge || savedEdge.sequence !== edge.sequence || !savedEdge.lineage.active) {
              throw new Error("The received work migration chain changed before its local commit.");
            }
            incomingMigrationFromLineage(server, edge, savedEdge);
          }
          const current = savedChain.get(expected.operationId);
          if (!current || current.sequence !== expected.sequence || current.status !== "pending" || !current.lineage.active) {
            throw new Error("The received work migration changed before its local commit.");
          }
          if (targetPrepared) await releaseMigratedTargetMetadataInDb(db, server, resolved.targetWork.identity);
          await saveIncomingMigration({ ...current, status: "completed", error: undefined }, db);
        },
      });
      if (result) {
        useReaderStore.getState().mergeNovelReaderState({
          sourceNovelId: result.sourceNovelId, targetNovelId: result.targetNovelId,
          chapterIdMap: result.chapterIdMap, preferredLastReadChapterId: result.preferredLastReadChapterId,
        });
        if (result.installedTargetMetadata) installedTargets.set(resolved.targetWork.id, result.installedTargetMetadata);
      }
      applied++;
    } catch (error) {
      signal.throwIfAborted(); assertCurrent();
      if (isAbortError(error)) throw error;
      const status = error instanceof ContentServerTransportError || error instanceof IncomingNovelMigrationRetryableError || (error instanceof ContentServerError && (error.status >= 500 || error.status === 408 || error.status === 429)) ? "failed" : "blocked";
      await saveIncomingMigration({ ...record, status, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const installed of installedTargets.values()) {
    assertCurrent(); signal.throwIfAborted();
    await recordInstalledWorkMetadata(server, installed, installed.metadata.cover !== null);
  }
  if (applied && typeof window !== "undefined") window.dispatchEvent(new Event("norea-content-state-changed"));
  const pending = await listIncomingMigrations(server);
  return { applied, pending: pending.length, ...(pending.length ? { error: pending[0]?.error, retryable: pending.some(record => record.status === "pending" || record.status === "failed") } : {}) };
}
