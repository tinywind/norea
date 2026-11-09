import { mergeIncomingNovelMetadata } from "../work-metadata/merge";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { findNovelBySource } from "../../db/queries/novel";
import { applyNovelMetadataToCache, knownNovelMetadataDirectory, rememberStoredNovelMetadata, scanStoredNovelChaptersToCache } from "../../db/work-metadata";
import { useContentSyncStore } from "../../store/content-sync";
import { bytesToBase64 } from "../base64";
import { availableNovelMetadataDirectory, installStoredNovelMetadata, parseNovelMetadata, readStoredNovelMetadata, type NovelMetadataV1 } from "../work-metadata";
import { ContentServerError, contentServerRequest, normalizeContentServerUrl, withContentServerLookup } from "./client";
import { registerContentDevice } from "./device";
import { serverWorkDeletionKey, withServerWorkDeletionExclusions, waitForServerWorkDeletion } from "./deletion-exclusions";
import { rememberServerNovelSource, type ServerNovelSource } from "./novel-source";
import { contentWorkId, recordInstalledWorkMetadata, runWorkMetadataSyncOperation, type WorkCatalogEntry } from "./works";
import { fetchServerChapters } from "./chapters";
import { cacheServerChapters, isNovelMigrationSourceHeldInDb, listNovelMigrations } from "../../db/queries/content-sync";
import { listIncomingMigrations } from "./migration-feed-state";
import type { MigrationWorkIdentity } from "./novel-migration-types";

export interface ServerWorkSummary {
  id: string;
  sequence: number;
  identity: NovelMetadataV1["identity"];
  novel: NovelMetadataV1["novel"];
  hasCover: boolean;
  chapterCount: number;
}
export interface ServerWorkPage { items: ServerWorkSummary[]; total: number; hasMore: boolean }
export interface ServerSourceSummary { id: string; workCount: number }

/** The server's largest accepted catalog page. */
const SERVER_WORK_PAGE_MAX = 100;

export function listServerWorks(server: string, token: string, query: string, source: string, offset: number, signal?: AbortSignal, limit = 40): Promise<ServerWorkPage> {
  const params = new URLSearchParams({ q: query, offset: String(offset), limit: String(limit) });
  if (source) params.set("source", source);
  return contentServerRequest(server, `/catalog/works?${params}`, token, "GET", undefined, signal);
}

/**
 * Every work matching the search and source, fetched in the largest pages the
 * server accepts. Concurrent server changes can shift offset pages, so works
 * are deduplicated by id. `onPage` receives the works loaded so far and the
 * server's current total.
 */
export async function listAllServerWorks(
  server: string, token: string, query: string, source: string,
  onPage?: (loaded: number, total: number) => void, signal?: AbortSignal,
): Promise<ServerWorkSummary[]> {
  const works = new Map<string, ServerWorkSummary>();
  let offset = 0;
  for (;;) {
    signal?.throwIfAborted();
    const page = await listServerWorks(server, token, query, source, offset, signal, SERVER_WORK_PAGE_MAX);
    for (const work of page.items) works.set(work.id, work);
    offset += page.items.length;
    onPage?.(works.size, Math.max(page.total, works.size));
    if (!page.hasMore || page.items.length === 0) return [...works.values()];
  }
}

export async function readServerCover(server: string, token: string, id: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
  return withContentServerLookup(async deadline => {
    const response = await nativeFetch(`${normalizeContentServerUrl(server)}/api/v1/works/${encodeURIComponent(id)}/cover`, {
      headers: { Authorization: `Bearer ${token}` }, maxRedirections: 0, connectTimeout: 10_000,
      signal: deadline,
    });
    if (!response.ok) throw new ContentServerError(response.status);
    if (Number(response.headers.get("content-length")) > 10 * 1024 * 1024) throw new Error("Server cover exceeds the size limit.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Server cover is empty or exceeds the size limit.");
    const contentType = response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    if (!contentType.startsWith("image/") && contentType !== "application/octet-stream") throw new Error("Server cover is not an image.");
    return { bytes, contentType };
  }, 30, signal);
}

export async function serverCoverSource(server: string, token: string, id: string, signal?: AbortSignal): Promise<string> {
  const cover = await readServerCover(server, token, id, signal);
  return `data:${cover.contentType === "application/octet-stream" ? "image/jpeg" : cover.contentType};base64,${bytesToBase64(cover.bytes)}`;
}

const migrationIdentityKey = (identity: MigrationWorkIdentity) =>
  JSON.stringify([identity.pluginId, identity.novelId, identity.novelPath]);

/** Resolve only saved completed migrations; chapter numbers and titles are never identity evidence. */
export async function resolveServerNovelTarget(serverUrl: string, work: ServerWorkSummary) {
  const server = normalizeContentServerUrl(serverUrl);
  if (await contentWorkId(work.identity) !== work.id) throw new Error("Server work identity does not match its metadata.");
  const [outgoing, incoming] = await Promise.all([
    listNovelMigrations(server, true), listIncomingMigrations(server, true),
  ]);
  const revoked = new Set(incoming.filter(receipt => receipt.status === "inactive").flatMap(receipt =>
    [receipt.operationId, ...(receipt.lineage.legacyOperationId ? [receipt.lineage.legacyOperationId] : [])]));
  const edges = new Map<string, Map<string, MigrationWorkIdentity>>();
  const remember = (source: MigrationWorkIdentity, target: MigrationWorkIdentity) => {
    const key = migrationIdentityKey(source);
    const targets = edges.get(key) ?? new Map<string, MigrationWorkIdentity>();
    targets.set(migrationIdentityKey(target), target);
    edges.set(key, targets);
  };
  for (const job of outgoing) {
    if (job.status === "completed" && !revoked.has(job.operationId)) remember(job.source, job.target);
  }
  for (const receipt of incoming) {
    if (receipt.status === "completed" && receipt.lineage.active && !revoked.has(receipt.operationId) &&
        (!receipt.lineage.legacyOperationId || !revoked.has(receipt.lineage.legacyOperationId))) remember(receipt.source, receipt.target);
  }
  let identity: MigrationWorkIdentity = work.identity;
  const seen = new Set<string>();
  for (;;) {
    const key = migrationIdentityKey(identity);
    if (seen.has(key)) throw new Error("The saved work migration history contains a cycle.");
    seen.add(key);
    const targets = edges.get(key);
    if (!targets?.size) break;
    if (targets.size !== 1) throw new Error("The saved work migration history has conflicting targets.");
    identity = targets.values().next().value!;
  }
  const migrated = migrationIdentityKey(identity) !== migrationIdentityKey(work.identity);
  const novel = await findNovelBySource(identity.pluginId, identity.novelPath);
  if (migrated && novel && (novel.isLocal || novel.sourceNovelId !== identity.novelId)) {
    throw new Error("The saved migration target no longer matches the local work.");
  }
  return {
    identity, novel, migrated,
    source: { serverUrl: server, workId: migrated ? await contentWorkId(identity) : work.id },
  };
}

export async function openServerNovel(server: string, work: ServerWorkSummary): Promise<number> {
  const target = await resolveServerNovelTarget(server, work);
  if (!target.novel) return refreshServerNovel(target.source, true);
  if (target.migrated) return refreshServerNovel(target.source, false, { id: target.novel.id, identity: target.identity });
  await rememberServerNovelSource(target.novel.id, target.source);
  return target.novel.id;
}

export async function refreshServerNovel(
  source: ServerNovelSource,
  requireNewWork = false,
  expectedNovel?: { id: number; identity: MigrationWorkIdentity },
): Promise<number> {
  const server = normalizeContentServerUrl(source.serverUrl);
  return runWorkMetadataSyncOperation(server, () => withServerWorkDeletionExclusions(server, async excluded => {
    const token = await registerContentDevice(server, useContentSyncStore.getState().deviceName);
    const entry = await contentServerRequest<WorkCatalogEntry>(server, `/works/${encodeURIComponent(source.workId)}`, token);
    const metadata = parseNovelMetadata(entry.metadata);
    if (entry.id !== source.workId || await contentWorkId(metadata.identity) !== source.workId) throw new Error("Server work identity does not match its metadata.");
    if (expectedNovel && migrationIdentityKey(metadata.identity) !== migrationIdentityKey(expectedNovel.identity)) {
      throw new Error("The server migration target identity changed before refresh.");
    }
    const cover = entry.hasCover ? await readServerCover(server, token, source.workId) : null;
    const chapters = await fetchServerChapters({ serverUrl: server, workId: source.workId }, token);
    await waitForServerWorkDeletion(server, source.workId);
    const isDeleted = () => excluded.has(serverWorkDeletionKey(metadata.identity));
    if (isDeleted()) throw new ContentServerError(410);
    const current = !requireNewWork
      ? await readStoredNovelMetadata(knownNovelMetadataDirectory(metadata.identity) ?? await availableNovelMetadataDirectory(metadata))
      : null;
    const reconciliation = current && Object.keys(current.metadata.chapters).some(number => !Object.hasOwn(metadata.chapters, number))
      ? await (await import("./incoming-chapter-number-reconciliation")).prepareIncomingChapterNumberReconciliation(
        server, token, entry, current.metadata, () => { if (isDeleted()) throw new ContentServerError(410); })
      : undefined;
    const previous = reconciliation?.previousMetadata ?? current?.metadata;
    // Opening a retired source refreshes the destination's source metadata, not its manual composition.
    const received = expectedNovel && previous?.chapterComposition
      ? { ...metadata, chapterComposition: previous.chapterComposition } : metadata;
    const incoming = previous ? mergeIncomingNovelMetadata(previous, received) : received;
    const install = reconciliation?.install ?? installStoredNovelMetadata;
    let retainedNovelId: number | null = null;
    const installed = await install(incoming, cover?.bytes, async (current, db) => {
      if (db && await isNovelMigrationSourceHeldInDb(db, server, metadata.identity)) throw new ContentServerError(410);
      if (isDeleted()) return false;
      if (!requireNewWork && !expectedNovel) return;
      if (!db) throw new Error("Cannot inspect the local work index outside its database transaction.");
      // This callback already owns the work storage lock and raw DB transaction.
      // A serialized query here would wait on our own transaction indefinitely.
      const [indexed] = await db.select<{ id: number; sourceNovelId: string | null }[]>(
        "SELECT id,source_novel_id AS sourceNovelId FROM novel WHERE plugin_id=$1 AND path=$2",
        [metadata.identity.pluginId, metadata.identity.novelPath],
      );
      if (isDeleted()) throw new ContentServerError(410);
      if (expectedNovel) {
        if (indexed?.id !== expectedNovel.id || indexed.sourceNovelId !== expectedNovel.identity.novelId) {
          throw new Error("The local migration target changed while refreshing its metadata.");
        }
        return;
      }
      if (indexed) {
        if (indexed.sourceNovelId && indexed.sourceNovelId !== metadata.identity.novelId) {
          throw new Error("Local work identity does not match the server metadata.");
        }
        retainedNovelId = indexed.id;
        return false;
      }
      if (!current) return;
      // Full-device restore can omit a work while deliberately preserving its
      // original files. Opening it indexes those files, without publishing the
      // server response over its existing metadata, cover, or chapter contents.
      retainedNovelId = await applyNovelMetadataToCache(db, current.metadata, current.directory);
      await scanStoredNovelChaptersToCache(db, retainedNovelId, current.directory);
      if (isDeleted()) throw new ContentServerError(410);
      await rememberStoredNovelMetadata(db, current.directory, current.metadata);
      await db.execute("DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2",
        [metadata.identity.pluginId, metadata.identity.novelPath]);
      if (isDeleted()) throw new ContentServerError(410);
      return false;
    });
    if (isDeleted()) throw new ContentServerError(410);
    if (installed === null && retainedNovelId === null) throw new Error("The local work changed while opening it. Open the work again.");
    if (installed !== null) await recordInstalledWorkMetadata(server, installed, entry.hasCover);
    const novel = await findNovelBySource(metadata.identity.pluginId, metadata.identity.novelPath);
    if (!novel) throw new Error("Installed server work is missing from the local index.");
    if (isDeleted()) throw new ContentServerError(410);
    if (installed !== null) await cacheServerChapters(novel.id, chapters);
    await rememberServerNovelSource(novel.id, { serverUrl: server, workId: source.workId });
    window.dispatchEvent(new Event("norea-content-state-changed"));
    return novel.id;
  }));
}
