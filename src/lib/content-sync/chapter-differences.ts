import { contentIdentity, listContentSyncChapters, listContentSyncWorkChapters, type ContentSyncChapter } from "../../db/queries/content-sync";
import {
  chapterPayloadStorageDir,
  inspectChapterPayloadInventory,
  resolveChapterPayloadDigests,
  type ChapterContentStorageIdentity,
  type ResolvedChapterPayloadDigestItem,
} from "../chapter-content/storage-platform";
import { type ChapterPayloadInventory } from "../chapter-content/inventory";
import { describeError } from "../errors";
import { fetchCleanupServerInventory } from "./chapter-inventory";
import { fetchServerChapterDigests, fetchServerChapters, type ServerChapterDigestSummary } from "./chapters";
import { contentServerRequest } from "./client";
import { getContentServerCapabilities, registerContentDevice } from "./device";
import { uploadContentChapter, withContentChapterStage, type CatalogEntry } from "./native";
import type { ServerNovelSource } from "./novel-source";
import { downloadServerChapterFromServer, runContentSyncOperation } from "./sync";
import { useContentSyncStore } from "../../store/content-sync";
import { chapterStorageRelativeDir } from "../chapter-storage-path";
import { resolvedChapterStorageDir } from "../chapter-storage-resolution";

const DIGEST_SCAN_CHUNK_SIZE = 50;
let digestScanSequence = 0;

export type ChapterDifferenceAction = "keep" | "upload" | "download";

export interface ChapterDifferenceLocalSummary {
  bodyBytes: number;
  bodySha256: string;
  payloadHash: string;
  fingerprint?: string;
}

export interface ChapterDifferenceRemoteSummary {
  serverUrl: string;
  id: string;
  revision: string;
  chapterPath: string;
  bodyBytes: number;
  bodySha256: string;
  payloadHash: string;
}

export interface ChapterDifference {
  chapter: ContentSyncChapter;
  local: ChapterDifferenceLocalSummary;
  remote: ChapterDifferenceRemoteSummary;
}

export interface ChapterDifferenceScan {
  differences: ChapterDifference[];
  checked: number;
  errors: { chapterId: number; message: string }[];
}

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function inventorySignature(inventory: ChapterPayloadInventory): string {
  return JSON.stringify([
    inventory.body ? [inventory.body.sha256, inventory.body.bytes] : null,
    inventory.expectedAssetKeys === null
      ? null
      : [...inventory.expectedAssetKeys].sort(compareCodepoint),
    [...inventory.storedAssets]
      .sort((a, b) => compareCodepoint(a.key, b.key))
      .map(asset => [asset.key, asset.sha256, asset.bytes]),
  ]);
}

export async function inventoryHash(inventory: ChapterPayloadInventory): Promise<string> {
  const bytes = new TextEncoder().encode(inventorySignature(inventory));
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function storageIdentity(row: ContentSyncChapter): ChapterContentStorageIdentity {
  return {
    novel: { id: row.novelId, pluginId: row.pluginId, sourceNovelId: row.sourceNovelId, path: row.novelPath, name: row.novelName },
    chapter: { id: row.chapterId, name: row.chapterName, chapterNumber: row.chapterNumber, position: row.position, contentType: row.contentType },
  };
}

function normalizedNumber(value: string | null | undefined): string | undefined {
  if (value == null || !/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : undefined;
}

function matchRemoteDigest(
  row: ContentSyncChapter,
  byPath: ReadonlyMap<string, ServerChapterDigestSummary>,
  byNumber: ReadonlyMap<string, readonly ServerChapterDigestSummary[]>,
): { kind: "match"; remote: ServerChapterDigestSummary } | { kind: "ambiguous" } | { kind: "none" } {
  const exact = byPath.get(row.chapterPath);
  if (exact) return { kind: "match", remote: exact };
  if (row.pluginId === "local") return { kind: "none" };
  const number = normalizedNumber(row.chapterNumber);
  if (number === undefined) return { kind: "none" };
  const matches = byNumber.get(number);
  if (!matches || matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "match", remote: matches[0]! };
}

async function serverInventory(row: ContentSyncChapter, source: ServerNovelSource, signal?: AbortSignal) {
  return fetchCleanupServerInventory({ identity: storageIdentity(row), novelPath: row.novelPath, chapterPath: row.chapterPath,
    novelName: row.novelName, chapterName: row.chapterName, serverSource: null, storageAmbiguous: false,
    localServerFingerprint: null, progress: 100 }, source.serverUrl, signal);
}

async function scanWithPrecomputedDigests(
  novel: { id: number; pluginId: string; path: string },
  source: ServerNovelSource,
  token: string,
  signal: AbortSignal,
  onProgress?: (checked: number, total: number) => void,
): Promise<ChapterDifferenceScan> {
  const remoteDigests = await fetchServerChapterDigests(source, token, signal);
  signal.throwIfAborted();

  const byPath = new Map<string, ServerChapterDigestSummary>();
  const byNumber = new Map<string, ServerChapterDigestSummary[]>();
  for (const item of remoteDigests) {
    byPath.set(item.chapterPath, item);
    const folderNumber = /^norea-folder:(\d+(?:\.\d+)?)$/.exec(item.chapterPath)?.[1];
    const entryNumber = normalizedNumber(item.chapterNumber);
    if (folderNumber === undefined || entryNumber === undefined || folderNumber === entryNumber) {
      const key = folderNumber ?? entryNumber;
      if (key !== undefined) {
        const list = byNumber.get(key);
        if (list) list.push(item);
        else byNumber.set(key, [item]);
      }
    }
  }

  const allLocalRows = await listContentSyncWorkChapters([JSON.stringify([novel.pluginId, novel.path])]);
  signal.throwIfAborted();

  const matched: { row: ContentSyncChapter; remote: ServerChapterDigestSummary }[] = [];
  for (const row of allLocalRows) {
    if (row.novelId !== novel.id) continue;
    const match = matchRemoteDigest(row, byPath, byNumber);
    if (match.kind === "match") {
      matched.push({ row, remote: match.remote });
    }
  }

  const localNumbers = new Map<string, number>();
  for (const { row } of matched) {
    const number = String(Number(row.chapterNumber ?? row.position));
    localNumbers.set(number, (localNumbers.get(number) ?? 0) + 1);
  }

  const result: ChapterDifferenceScan = { differences: [], checked: 0, errors: [] };
  const total = matched.length;
  onProgress?.(0, total);

  const pending: { row: ContentSyncChapter; remote: ServerChapterDigestSummary; chapterDir: string }[] = [];
  for (const { row, remote } of matched) {
    signal.throwIfAborted();
    if ((localNumbers.get(String(Number(row.chapterNumber ?? row.position))) ?? 0) > 1) {
      result.errors.push({ chapterId: row.chapterId, message: "Chapter storage number is ambiguous." });
      result.checked++;
      continue;
    }
    if (remote.error) {
      result.errors.push({ chapterId: row.chapterId, message: remote.error });
      result.checked++;
      continue;
    }
    if (!remote.payloadHash || !remote.bodySha256 || remote.bodyBytes == null) {
      result.checked++;
      continue;
    }
    try {
      const chapterDir = chapterPayloadStorageDir(storageIdentity(row));
      pending.push({ row, remote, chapterDir });
    } catch (error) {
      result.errors.push({ chapterId: row.chapterId, message: describeError(error) });
      result.checked++;
    }
  }
  if (result.checked > 0) onProgress?.(result.checked, total);

  const scanId = `chapter-diff-${Date.now()}-${++digestScanSequence}`;
  for (let offset = 0; offset < pending.length; offset += DIGEST_SCAN_CHUNK_SIZE) {
    signal.throwIfAborted();
    const chunk = pending.slice(offset, offset + DIGEST_SCAN_CHUNK_SIZE);
    const resolvedList = await resolveChapterPayloadDigests(
      scanId,
      chunk.map(({ row, chapterDir }) => ({ chapterId: row.chapterId, chapterDir })),
      signal,
    );
    signal.throwIfAborted();
    const resolvedById = new Map<number, ResolvedChapterPayloadDigestItem>(
      resolvedList.map(item => [item.chapterId, item]),
    );
    for (const { row, remote } of chunk) {
      const local = resolvedById.get(row.chapterId);
      if (local?.error) {
        result.errors.push({ chapterId: row.chapterId, message: local.error });
      } else if (
        local &&
        local.payloadHash !== null &&
        local.bodySha256 !== null &&
        local.bodyBytes !== null &&
        local.payloadHash !== remote.payloadHash
      ) {
        result.differences.push({
          chapter: row,
          local: {
            bodyBytes: local.bodyBytes,
            bodySha256: local.bodySha256,
            payloadHash: local.payloadHash,
          },
          remote: {
            serverUrl: source.serverUrl,
            id: remote.id,
            revision: remote.revision,
            chapterPath: remote.chapterPath,
            bodyBytes: remote.bodyBytes!,
            bodySha256: remote.bodySha256!,
            payloadHash: remote.payloadHash!,
          },
        });
      }
      result.checked++;
    }
    onProgress?.(result.checked, total);
  }
  return result;
}

async function scanWithLegacyInventory(
  novel: { id: number; pluginId: string; path: string },
  source: ServerNovelSource,
  token: string,
  signal: AbortSignal,
  onProgress?: (checked: number, total: number) => void,
): Promise<ChapterDifferenceScan> {
  const remote = await fetchServerChapters(source, token, signal);
  signal.throwIfAborted();
  const paths = new Set(remote.map(chapter => chapter.chapterPath));
  const numbers = new Map<string, number>();
  for (const chapter of remote) {
    if (chapter.chapterNumber != null) {
      const key = String(Number(chapter.chapterNumber));
      numbers.set(key, (numbers.get(key) ?? 0) + 1);
    }
  }
  const rows = (await listContentSyncWorkChapters([JSON.stringify([novel.pluginId, novel.path])]))
    .filter(row => row.novelId === novel.id && (paths.has(row.chapterPath)
      || (row.pluginId !== "local" && row.chapterNumber != null && numbers.get(String(Number(row.chapterNumber))) === 1)));
  const result: ChapterDifferenceScan = { differences: [], checked: 0, errors: [] };
  const localNumbers = new Map<string, number>();
  for (const row of rows) {
    const number = String(Number(row.chapterNumber ?? row.position));
    localNumbers.set(number, (localNumbers.get(number) ?? 0) + 1);
  }
  onProgress?.(0, rows.length);
  for (const row of rows) {
    signal.throwIfAborted();
    try {
      if ((localNumbers.get(String(Number(row.chapterNumber ?? row.position))) ?? 0) > 1) throw new Error("Chapter storage number is ambiguous.");
      const local = await inspectChapterPayloadInventory(storageIdentity(row), signal);
      if (local.body) {
        const remoteCopy = await serverInventory(row, source, signal);
        if (remoteCopy.inventory.body) {
          const localHash = local.payloadHash ?? await inventoryHash(local);
          const remoteHash = await inventoryHash(remoteCopy.inventory);
          if (localHash !== remoteHash) {
            result.differences.push({
              chapter: row,
              local: {
                bodyBytes: local.body.bytes,
                bodySha256: local.body.sha256,
                payloadHash: localHash,
                fingerprint: local.fingerprint,
              },
              remote: {
                serverUrl: remoteCopy.serverUrl,
                id: remoteCopy.id,
                revision: remoteCopy.revision,
                chapterPath: remoteCopy.identity.chapterPath,
                bodyBytes: remoteCopy.inventory.body.bytes,
                bodySha256: remoteCopy.inventory.body.sha256,
                payloadHash: remoteHash,
              },
            });
          }
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      result.errors.push({ chapterId: row.chapterId, message: describeError(error) });
    }
    result.checked++;
    onProgress?.(result.checked, rows.length);
  }
  return result;
}

export async function scanChapterDifferences(
  novel: { id: number; pluginId: string; path: string }, source: ServerNovelSource, signal: AbortSignal,
  onProgress?: (checked: number, total: number) => void,
): Promise<ChapterDifferenceScan> {
  signal.throwIfAborted();
  const token = await registerContentDevice(source.serverUrl, useContentSyncStore.getState().deviceName, signal);
  signal.throwIfAborted();
  const capabilities = await getContentServerCapabilities(source.serverUrl, signal);
  signal.throwIfAborted();
  if (capabilities.chapterDigestVersion === 1) {
    return scanWithPrecomputedDigests(novel, source, token, signal, onProgress);
  }
  return scanWithLegacyInventory(novel, source, token, signal, onProgress);
}

export async function applyChapterDifferences(
  source: ServerNovelSource, plan: readonly { difference: ChapterDifference; action: ChapterDifferenceAction }[],
  onProgress: (done: number, total: number) => void,
): Promise<{ completed: number[]; errors: { chapterId: number; message: string }[] }> {
  return runContentSyncOperation(async () => {
    const jobs = plan.filter(item => item.action !== "keep");
    const result: { completed: number[]; errors: { chapterId: number; message: string }[] } = { completed: [], errors: [] };
    const token = await registerContentDevice(source.serverUrl, useContentSyncStore.getState().deviceName);
    let done = 0;
    for (const { difference, action } of jobs) {
      const original = difference.chapter;
      try {
        const row = (await listContentSyncChapters([contentIdentity(original.pluginId, original.novelPath, original.chapterPath)]))
          .find(current => current.chapterId === original.chapterId);
        if (!row || row.isDownloadQueued || row.chapterPath !== original.chapterPath || row.sourceNovelId !== original.sourceNovelId
          || row.chapterNumber !== original.chapterNumber || row.position !== original.position) throw new Error("Chapter identity changed. Compare again.");
        let pinnedFingerprint = difference.local.fingerprint;
        const verifyLocal = async () => {
          const current = await inspectChapterPayloadInventory(storageIdentity(row));
          const currentHash = current.body ? (current.payloadHash ?? await inventoryHash(current)) : null;
          if (
            !current.body ||
            currentHash !== difference.local.payloadHash ||
            (pinnedFingerprint !== undefined && current.fingerprint !== pinnedFingerprint)
          ) {
            throw new Error("Device chapter changed. Compare again.");
          }
          pinnedFingerprint = current.fingerprint;
        };
        await verifyLocal();
        const remote = await serverInventory(row, source);
        const remoteHash = await inventoryHash(remote.inventory);
        if (remote.id !== difference.remote.id || remote.revision !== difference.remote.revision
          || remoteHash !== difference.remote.payloadHash) throw new Error("Server chapter changed. Compare again.");
        const query = new URLSearchParams({ pluginId: row.pluginId, novelPath: row.novelPath, chapterPath: remote.identity.chapterPath });
        const entry = await contentServerRequest<CatalogEntry>(source.serverUrl, `/catalog/chapter?${query}`, token);
        if (entry.id !== remote.id || entry.revision !== remote.revision || entry.deleted) throw new Error("Server chapter changed. Compare again.");
        if (action === "download") {
          await downloadServerChapterFromServer(entry, source.serverUrl, { token,
            target: { pluginId: row.pluginId, novelPath: row.novelPath, chapterPath: row.chapterPath }, expectedLocalFingerprint: pinnedFingerprint });
        } else {
          if (row.pluginId === "local" || row.isLocal) {
            throw new Error("Local files cannot be uploaded to the content server.");
          }
          const storageDir = resolvedChapterStorageDir(row.chapterId) ?? chapterStorageRelativeDir(storageIdentity(row).novel, storageIdentity(row).chapter);
          await withContentChapterStage({ storageDir, identity: { pluginId: row.pluginId, novelPath: row.novelPath }, verifySource: verifyLocal }, async stagePath => {
            await uploadContentChapter({ serverUrl: source.serverUrl, token, chapterId: row.chapterId, conflictPolicy: "replace-server", storageDir, stagePath,
              manifest: { packageVersion: 1, identity: remote.identity,
                novel: { name: row.novelName, author: row.author, summary: row.summary, isLocal: row.isLocal },
                chapter: { name: row.chapterName, position: row.position, chapterNumber: row.chapterNumber, page: row.page, contentType: row.contentType } } });
          });
        }
        const verifiedLocal = await inspectChapterPayloadInventory(storageIdentity(row));
        const verifiedRemote = await serverInventory(row, source);
        if (inventorySignature(verifiedLocal) !== inventorySignature(verifiedRemote.inventory)) throw new Error("Chapter copies still differ. Compare again.");
        result.completed.push(row.chapterId);
      } catch (error) {
        result.errors.push({ chapterId: original.chapterId, message: describeError(error) });
      }
      onProgress(++done, jobs.length);
    }
    return result;
  });
}
