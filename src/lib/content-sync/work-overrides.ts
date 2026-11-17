import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { findNovelBySource, getNovelById } from "../../db/queries/novel";
import { listNovelOverrides, mergeNovelOverride } from "../../db/queries/novel-override";
import { useContentSyncStore } from "../../store/content-sync";
import { LOCAL_PLUGIN_ID } from "../plugins/types";
import { parseWorkOverride, type WorkOverrideV1 } from "../work-metadata/override";
import { ContentServerError, contentServerRequest, normalizeContentServerUrl, withContentServerLookup } from "./client";
import { registerContentDevice } from "./device";
import { readServerNovelSource } from "./novel-source";
import { contentWorkId } from "./works";

interface ServerWorkOverride { revision: number; override: unknown }
interface ServerWorkOverridePage { items: Array<ServerWorkOverride & { workId: string }>; cursor: number; hasMore: boolean }
/** The last server revision read and, per work, the fields both sides last agreed on. */
interface WorkOverrideSyncCache { cursor: number; synced: Record<string, string> }

const PAGE_SIZE = 100;
const cacheKey = (server: string) => `norea-content-overrides:${normalizeContentServerUrl(server)}`;
const supportByServer = new Map<string, boolean>();

async function readCache(server: string): Promise<WorkOverrideSyncCache> {
  const saved = await readContentSyncCache(cacheKey(server));
  return saved ? JSON.parse(saved) as WorkOverrideSyncCache : { cursor: 0, synced: {} };
}

function fieldsKey(override: WorkOverrideV1 | null): string {
  const fields = override?.fields ?? {};
  return JSON.stringify(Object.keys(fields).sort().map(name => [name, fields[name]!.value, fields[name]!.updatedAt]));
}

/** A server without the capability keeps overrides on this device only. */
export async function serverSupportsWorkOverrides(server: string, signal?: AbortSignal): Promise<boolean> {
  const key = normalizeContentServerUrl(server);
  const known = supportByServer.get(key);
  if (known !== undefined) return known;
  const capabilities = await contentServerRequest<{ workOverrideVersion?: number }>(key, "/capabilities", undefined, "GET", undefined, signal);
  const supported = capabilities.workOverrideVersion === 1;
  supportByServer.set(key, supported);
  return supported;
}

export function resetWorkOverrideSupportForTests(): void {
  supportByServer.clear();
}

function isMissingOnServer(error: unknown): boolean {
  return error instanceof ContentServerError && (error.status === 404 || error.status === 410);
}

const syncQueues = new Map<string, Promise<unknown>>();

/** One exchange per server at a time, so two passes never write the same cursor and agreement cache. */
function queued<T>(server: string, operation: () => Promise<T>): Promise<T> {
  const key = normalizeContentServerUrl(server);
  const next = (syncQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation)
    .finally(() => { if (syncQueues.get(key) === next) syncQueues.delete(key); });
  syncQueues.set(key, next);
  return next;
}

/**
 * Exchanges user-set work metadata with the server: reads the overrides changed there since the last
 * pass into the works this device has, then sends the local overrides the server has not seen.
 * The newer edit of each field wins on both sides.
 */
export function syncWorkOverrides(
  server: string, token: string, upload = true, assertCurrent: () => void = () => undefined, signal?: AbortSignal,
): Promise<void> {
  return queued(server, () => exchangeWorkOverrides(server, token, upload, assertCurrent, signal));
}

async function exchangeWorkOverrides(server: string, token: string, upload: boolean, assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
  if (!await serverSupportsWorkOverrides(server, signal)) return;
  assertCurrent();
  const cache = await readCache(server);
  for (;;) {
    const page = await contentServerRequest<ServerWorkOverridePage>(server, `/work-overrides?after=${cache.cursor}&limit=${PAGE_SIZE}`, token, "GET", undefined, signal);
    assertCurrent();
    for (const item of page.items) {
      const remote = parseWorkOverride(item.override);
      if (await contentWorkId(remote.identity) !== item.workId) throw new Error("Server work override identity does not match its work.");
      const novel = await findNovelBySource(remote.identity.pluginId, remote.identity.novelPath);
      // A work this device does not have reads its override when it is installed or opened.
      if (!novel || novel.sourceNovelId !== remote.identity.novelId) continue;
      const merged = await mergeNovelOverride(novel.id, remote);
      if (fieldsKey(merged.document) === fieldsKey(remote)) cache.synced[item.workId] = fieldsKey(remote);
      else delete cache.synced[item.workId];
    }
    if (page.items.length > 0 && page.cursor <= cache.cursor) throw new Error("Server work override cursor did not advance.");
    cache.cursor = Math.max(cache.cursor, page.cursor);
    await writeContentSyncCache(cacheKey(server), JSON.stringify(cache));
    if (!page.hasMore) break;
  }

  if (!upload) return;
  let dirty = false;
  for (const local of await listNovelOverrides()) {
    assertCurrent();
    const { identity } = local.document;
    if (local.isLocal || identity.pluginId === LOCAL_PLUGIN_ID || !identity.novelId) continue;
    const workId = await contentWorkId(identity);
    if (cache.synced[workId] === fieldsKey(local.document)) continue;
    let stored: ServerWorkOverride;
    try {
      stored = await contentServerRequest<ServerWorkOverride>(server, `/works/${workId}/override`, token, "PUT", local.document, signal);
    } catch (error) {
      // The work itself is not on this server; its override stays on this device.
      if (isMissingOnServer(error)) continue;
      // One work the server refuses must not stop the rest of the sync.
      if (error instanceof ContentServerError && error.status === 400) {
        console.warn("[content-sync] the server refused a work override:", identity.pluginId, identity.novelPath);
        continue;
      }
      throw error;
    }
    const merged = parseWorkOverride(stored.override);
    const applied = fieldsKey(merged) === fieldsKey(local.document)
      ? local.document
      : (await mergeNovelOverride(local.novelId, merged)).document;
    if (fieldsKey(applied) === fieldsKey(merged)) cache.synced[workId] = fieldsKey(merged);
    else delete cache.synced[workId];
    dirty = true;
  }
  if (dirty) await writeContentSyncCache(cacheKey(server), JSON.stringify(cache));
}

/** Reads one work's override from the server into the local work. Resolves true when local values changed. */
export async function pullWorkOverride(server: string, token: string, novelId: number, workId: string, signal?: AbortSignal): Promise<boolean> {
  if (!await serverSupportsWorkOverrides(server, signal)) return false;
  let stored: ServerWorkOverride;
  try {
    stored = await contentServerRequest<ServerWorkOverride>(server, `/works/${workId}/override`, token, "GET", undefined, signal);
  } catch (error) {
    if (isMissingOnServer(error)) return false;
    throw error;
  }
  const remote = parseWorkOverride(stored.override);
  if (await contentWorkId(remote.identity) !== workId) throw new Error("Server work override identity does not match its work.");
  return (await mergeNovelOverride(novelId, remote)).changed;
}

/** Opening a work reads its override from its content server, within the server lookup deadline. */
export async function pullWorkOverrideOnOpen(novelId: number, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const settings = useContentSyncStore.getState();
  const source = await readServerNovelSource(novelId);
  const server = source?.serverUrl ?? settings.serverUrl;
  if (!server) return false;
  const novel = await getNovelById(novelId);
  if (!novel || novel.isLocal || novel.pluginId === LOCAL_PLUGIN_ID || !novel.sourceNovelId) return false;
  const workId = source?.workId ?? await contentWorkId({ pluginId: novel.pluginId, novelPath: novel.path });
  return withContentServerLookup(async deadline => {
    const token = await registerContentDevice(server, settings.deviceName, deadline);
    deadline.throwIfAborted();
    return pullWorkOverride(server, token, novelId, workId, deadline);
  }, settings.lookupTimeoutSeconds, signal);
}

/** Sends a just-edited override without waiting for the next content sync; failures wait for that sync. */
export async function pushWorkOverridesNow(): Promise<void> {
  const settings = useContentSyncStore.getState();
  if (!settings.serverUrl) return;
  const token = await registerContentDevice(settings.serverUrl, settings.deviceName);
  await syncWorkOverrides(settings.serverUrl, token);
}
