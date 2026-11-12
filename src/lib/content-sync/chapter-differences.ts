import { contentIdentity, listContentSyncChapters, listContentSyncWorkChapters, type ContentSyncChapter } from "../../db/queries/content-sync";
import { inspectChapterPayloadInventory, type ChapterContentStorageIdentity } from "../chapter-content/storage-platform";
import { type ChapterPayloadInventory, type ChapterPayloadSnapshot } from "../chapter-content/inventory";
import { describeError } from "../errors";
import { fetchCleanupServerInventory, type ServerChapterInventory } from "./chapter-inventory";
import { fetchServerChapters } from "./chapters";
import { contentServerRequest } from "./client";
import { registerContentDevice } from "./device";
import { uploadContentChapter, withContentChapterStage, type CatalogEntry } from "./native";
import type { ServerNovelSource } from "./novel-source";
import { downloadServerChapterFromServer, runContentSyncOperation } from "./sync";
import { useContentSyncStore } from "../../store/content-sync";
import { chapterStorageRelativeDir } from "../chapter-storage-path";
import { resolvedChapterStorageDir } from "../chapter-storage-resolution";

export type ChapterDifferenceAction = "keep" | "upload" | "download";
export interface ChapterDifference {
  chapter: ContentSyncChapter;
  local: ChapterPayloadSnapshot;
  remote: ServerChapterInventory;
}
export interface ChapterDifferenceScan {
  differences: ChapterDifference[];
  checked: number;
  errors: { chapterId: number; message: string }[];
}

export function inventorySignature(inventory: ChapterPayloadInventory): string {
  return JSON.stringify([inventory.body ? [inventory.body.sha256, inventory.body.bytes] : null, inventory.expectedAssetKeys === null ? null : [...inventory.expectedAssetKeys].sort(),
    [...inventory.storedAssets].sort((a, b) => a.key.localeCompare(b.key)).map(asset => [asset.key, asset.sha256, asset.bytes])]);
}

function storageIdentity(row: ContentSyncChapter): ChapterContentStorageIdentity {
  return {
    novel: { id: row.novelId, pluginId: row.pluginId, sourceNovelId: row.sourceNovelId, path: row.novelPath, name: row.novelName },
    chapter: { id: row.chapterId, name: row.chapterName, chapterNumber: row.chapterNumber, position: row.position, contentType: row.contentType },
  };
}

async function serverInventory(row: ContentSyncChapter, source: ServerNovelSource, signal?: AbortSignal) {
  return fetchCleanupServerInventory({ identity: storageIdentity(row), novelPath: row.novelPath, chapterPath: row.chapterPath,
    novelName: row.novelName, chapterName: row.chapterName, serverSource: null, storageAmbiguous: false,
    localServerFingerprint: null, unread: false }, source.serverUrl, signal);
}

export async function scanChapterDifferences(
  novel: { id: number; pluginId: string; path: string }, source: ServerNovelSource, signal: AbortSignal,
  onProgress?: (checked: number, total: number) => void,
): Promise<ChapterDifferenceScan> {
  signal.throwIfAborted();
  const token = await registerContentDevice(source.serverUrl, useContentSyncStore.getState().deviceName, signal);
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
      || (row.chapterNumber != null && numbers.get(String(Number(row.chapterNumber))) === 1)));
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
        const remote = await serverInventory(row, source, signal);
        if (remote.inventory.body && inventorySignature(local) !== inventorySignature(remote.inventory)) {
          result.differences.push({ chapter: row, local, remote });
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
        const verifyLocal = async () => {
          const current = await inspectChapterPayloadInventory(storageIdentity(row));
          if (current.fingerprint !== difference.local.fingerprint) throw new Error("Device chapter changed. Compare again.");
        };
        await verifyLocal();
        const remote = await serverInventory(row, source);
        if (remote.id !== difference.remote.id || remote.revision !== difference.remote.revision
          || inventorySignature(remote.inventory) !== inventorySignature(difference.remote.inventory)) throw new Error("Server chapter changed. Compare again.");
        const query = new URLSearchParams({ pluginId: row.pluginId, novelPath: row.novelPath, chapterPath: remote.identity.chapterPath });
        const entry = await contentServerRequest<CatalogEntry>(source.serverUrl, `/catalog/chapter?${query}`, token);
        if (entry.id !== remote.id || entry.revision !== remote.revision || entry.deleted) throw new Error("Server chapter changed. Compare again.");
        if (action === "download") {
          await downloadServerChapterFromServer(entry, source.serverUrl, { token,
            target: { pluginId: row.pluginId, novelPath: row.novelPath, chapterPath: row.chapterPath }, expectedLocalFingerprint: difference.local.fingerprint });
        } else {
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
