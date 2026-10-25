import { applyReadingStateBatch, listReadingStatePage, READING_STATE_BATCH_SIZE } from "../../db/queries/reading-state";
import { useContentSyncStore } from "../../store/content-sync";
import { useReaderStore } from "../../store/reader";
import { contentServerRequest, normalizeContentServerUrl } from "./client";
import { registerContentDevice, type ContentCapabilities } from "./device";
import { isReadingStateEntry, type ReadingStateEntry } from "./reading-state-model";

export type ReadingSyncMode = "pull" | "push" | "merge";
export interface ReadingSyncResult {
  uploaded: number;
  downloaded: number;
  serverUpdated: number;
  localUpdated: number;
  skipped: number;
}
export interface ReadingSyncProgress extends ReadingSyncResult { phase: "upload" | "download" }

export class ReadingSyncError extends Error {
  constructor(public code: "invalidKey" | "unsupported" | "changed" | "invalidResponse" | "busy") { super(code); }
}

export function validReadingSyncKey(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
export function createReadingSyncKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}
function storageKey(server: string): string { return `norea-reading-sync-key:${normalizeContentServerUrl(server)}`; }
export function readReadingSyncKey(server: string): string {
  return server ? localStorage.getItem(storageKey(server)) ?? "" : "";
}
export function saveReadingSyncKey(server: string, value: string): string {
  const key = value.trim().toLowerCase();
  if (!validReadingSyncKey(key)) throw new ReadingSyncError("invalidKey");
  localStorage.setItem(storageKey(server), key);
  if (readReadingSyncKey(server) !== key) throw new Error("Reading sync key could not be saved.");
  return key;
}

/** Stay below the server's JSON body limit, even with long source URLs. */
export function readingStateUploadBatches(entries: readonly ReadingStateEntry[]): ReadingStateEntry[][] {
  const batches: ReadingStateEntry[][] = [];
  let batch: ReadingStateEntry[] = [];
  let bytes = 1024;
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const entryBytes = encoder.encode(JSON.stringify(entry)).byteLength + 1;
    if (entryBytes > 500 * 1024) throw new Error("Reading-state entry exceeds the request size limit.");
    if (batch.length && (batch.length >= READING_STATE_BATCH_SIZE || bytes + entryBytes > 512 * 1024)) {
      batches.push(batch); batch = []; bytes = 1024;
    }
    batch.push(entry); bytes += entryBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

interface ReadResponse { entries: ReadingStateEntry[]; total: number; nextOffset: number | null }
interface MergeResponse { received: number; updated: number; total: number }
let inFlight = false;

export async function syncReadingState(
  serverUrl: string, syncKey: string, mode: ReadingSyncMode,
  onProgress?: (progress: ReadingSyncProgress) => void,
  signal?: AbortSignal,
): Promise<ReadingSyncResult> {
  if (inFlight) throw new ReadingSyncError("busy");
  if (!validReadingSyncKey(syncKey)) throw new ReadingSyncError("invalidKey");
  const server = normalizeContentServerUrl(serverUrl);
  const result: ReadingSyncResult = { uploaded: 0, downloaded: 0, serverUpdated: 0, localUpdated: 0, skipped: 0 };
  const assertSource = () => {
    signal?.throwIfAborted();
    if (useContentSyncStore.getState().serverUrl !== server || readReadingSyncKey(server) !== syncKey) throw new ReadingSyncError("changed");
  };
  inFlight = true;
  try {
    assertSource();
    // Never send a private profile key to a server that has not advertised this protocol.
    const capabilities = await contentServerRequest<ContentCapabilities>(server, "/capabilities", undefined, "GET", undefined, signal);
    assertSource();
    if (capabilities.apiVersion !== 1 || capabilities.packageVersion !== 1 || capabilities.authentication !== "device-key"
      || capabilities.personalStateSync !== true || capabilities.readingStateVersion !== 1) throw new ReadingSyncError("unsupported");
    const token = await registerContentDevice(server, useContentSyncStore.getState().deviceName, signal);
    assertSource();
    if (mode !== "pull") {
      let afterId = 0;
      onProgress?.({ ...result, phase: "upload" });
      for (;;) {
        const page = await listReadingStatePage(afterId);
        assertSource();
        for (const entries of readingStateUploadBatches(page.entries)) {
          const response = await contentServerRequest<MergeResponse>(server, "/reading-state/merge", token, "POST", { syncKey, entries }, signal);
          assertSource();
          if (response.received !== entries.length || !Number.isSafeInteger(response.updated) || response.updated < 0
            || response.updated > response.received || !Number.isSafeInteger(response.total) || response.total < 0) throw new ReadingSyncError("invalidResponse");
          result.uploaded += response.received; result.serverUpdated += response.updated;
          onProgress?.({ ...result, phase: "upload" });
        }
        if (page.nextId === null) break;
        if (page.nextId <= afterId) throw new ReadingSyncError("invalidResponse");
        afterId = page.nextId;
      }
    }
    if (mode !== "push") {
      let offset = 0;
      let initialTotal: number | undefined;
      onProgress?.({ ...result, phase: "download" });
      for (;;) {
        const response = await contentServerRequest<ReadResponse>(server, "/reading-state/read", token, "POST",
          { syncKey, offset, limit: READING_STATE_BATCH_SIZE }, signal);
        assertSource();
        if (!Array.isArray(response.entries) || response.entries.length > READING_STATE_BATCH_SIZE
          || !response.entries.every(isReadingStateEntry) || !Number.isSafeInteger(response.total) || response.total < 0
          || (response.nextOffset !== null && (!Number.isSafeInteger(response.nextOffset)
            || response.nextOffset !== offset + response.entries.length || response.nextOffset <= offset))) throw new ReadingSyncError("invalidResponse");
        initialTotal ??= response.total;
        const entries = response.entries.slice(0, Math.max(0, initialTotal - offset));
        const applied = await applyReadingStateBatch(entries, assertSource);
        for (const lastRead of applied.lastReadChapters) useReaderStore.getState().setLastReadChapter(lastRead.novelId, lastRead.chapterId);
        result.downloaded += entries.length; result.localUpdated += applied.updated; result.skipped += applied.skipped;
        onProgress?.({ ...result, phase: "download" });
        if (response.nextOffset === null || response.nextOffset >= initialTotal) break;
        offset = response.nextOffset;
      }
    }
    return result;
  } finally { inFlight = false; }
}
