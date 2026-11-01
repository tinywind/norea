import { listChapterCleanupCandidates, type ChapterCleanupCandidate, type ChapterCleanupSelection } from "../db/queries/chapter-cleanup";
import { useContentSyncStore } from "../store/content-sync";
import { inspectChapterPayloadInventory } from "./chapter-content/storage-platform";
import { compareChapterInventories, type ChapterPayloadSnapshot } from "./chapter-content/inventory";
import { cleanupServerUrl, fetchCleanupServerInventory, type ServerChapterInventory } from "./content-sync/chapter-inventory";
import { ContentServerError } from "./content-sync/client";

export type ChapterCleanupServerMode = "server-present" | "server-coverage" | "server-contains-local" | "any";
export interface ChapterCleanupFilters extends ChapterCleanupSelection { server: ChapterCleanupServerMode }
export type ChapterCleanupSkipReason = "no-payload" | "no-server" | "server-missing" | "server-conflict" | "server-auth" | "server-unavailable" | "server-timeout" | "server-error" | "storage-error" | "not-covered" | "not-contained" | "not-comparable" | "changed" | "ambiguous-storage";
export interface ChapterCleanupTarget {
  candidate: ChapterCleanupCandidate;
  snapshot: ChapterPayloadSnapshot;
  server: ServerChapterInventory | null;
}
export interface ChapterCleanupPreview {
  filters: ChapterCleanupFilters;
  serverSetting: string;
  targets: readonly ChapterCleanupTarget[];
  checked: number;
  checkedServers: readonly string[];
  workCount: number;
  payloadBytes: number;
  skipped: Partial<Record<ChapterCleanupSkipReason, number>>;
}

export function chapterCleanupInventorySkip(mode: ChapterCleanupServerMode, local: ChapterPayloadSnapshot, server: ServerChapterInventory | null): ChapterCleanupSkipReason | null {
  if (local.payloadBytes <= 0) return "no-payload";
  if (mode === "any") return null;
  if (!server?.inventory.body) return "server-missing";
  if (mode === "server-present") return null;
  const comparison = compareChapterInventories(local, server.inventory);
  if (mode === "server-coverage") return comparison.coverageEligible ? null : comparison.coverageReason ? "not-comparable" : "not-covered";
  return comparison.containsLocal ? null : comparison.containmentReason ? "not-comparable" : "not-contained";
}

export function cleanupServerFailure(error: unknown): ChapterCleanupSkipReason {
  if (error instanceof ContentServerError) {
    if (error.status === 404) return "server-missing";
    if (error.status === 409) return "server-conflict";
    if (error.status === 401 || error.status === 403) return "server-auth";
    if (error.status === 410) return "server-unavailable";
  }
  if (error instanceof Error && (error.name === "TimeoutError" || /timed out|timeout/i.test(error.message))) return "server-timeout";
  return "server-error";
}

function freezeCleanupEvidence<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeCleanupEvidence(child);
    Object.freeze(value);
  }
  return value;
}

export async function previewChapterCleanup(filters: ChapterCleanupFilters, signal?: AbortSignal, onProgress?: (checked: number) => void): Promise<ChapterCleanupPreview> {
  const frozenFilters: ChapterCleanupFilters = Object.freeze({ ...filters, categories: Object.freeze(filters.categories.mode === "all"
    ? { mode: "all" as const } : { mode: "selected" as const, ids: Object.freeze([...filters.categories.ids]) }) });
  const serverSetting = useContentSyncStore.getState().serverUrl;
  const targets: ChapterCleanupTarget[] = [];
  const checkedServers = new Set<string>();
  const skipped: ChapterCleanupPreview["skipped"] = {};
  const skip = (reason: ChapterCleanupSkipReason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  let afterId = 0;
  let checked = 0;
  let lastProgress = 0;
  for (;;) {
    signal?.throwIfAborted();
    const page = await listChapterCleanupCandidates(frozenFilters, { afterId });
    if (!page.length) break;
    for (const candidate of page) {
      signal?.throwIfAborted();
      checked++;
      if (candidate.storageAmbiguous) { skip("ambiguous-storage"); continue; }
      let snapshot: ChapterPayloadSnapshot;
      try { snapshot = await inspectChapterPayloadInventory(candidate.identity, signal); }
      catch { signal?.throwIfAborted(); skip("storage-error"); continue; }
      if (candidate.localServerFingerprint && candidate.localServerFingerprint !== snapshot.fingerprint) { skip("changed"); continue; }
      if (snapshot.payloadBytes <= 0) { skip("no-payload"); continue; }
      let server: ServerChapterInventory | null = null;
      if (frozenFilters.server !== "any") {
        try {
          const serverUrl = cleanupServerUrl(candidate, serverSetting);
          if (!serverUrl) { skip("no-server"); continue; }
          checkedServers.add(serverUrl);
          server = await fetchCleanupServerInventory(candidate, serverUrl, signal, frozenFilters.server === "server-present");
        } catch (error) { signal?.throwIfAborted(); skip(cleanupServerFailure(error)); continue; }
      }
      const reason = chapterCleanupInventorySkip(frozenFilters.server, snapshot, server);
      if (reason) skip(reason);
      else targets.push(freezeCleanupEvidence(structuredClone({ candidate, snapshot, server })));
      if (Date.now() - lastProgress >= 100) { onProgress?.(checked); lastProgress = Date.now(); }
    }
    afterId = page[page.length - 1]!.identity.chapter.id;
    onProgress?.(checked);
  }
  signal?.throwIfAborted();
  if (filters.server !== "any" && serverSetting !== useContentSyncStore.getState().serverUrl) throw new Error("Content server settings changed. Preview again.");
  return Object.freeze({ filters: frozenFilters, serverSetting, targets: Object.freeze(targets), checked, checkedServers: Object.freeze([...checkedServers]),
    workCount: new Set(targets.map(target=>target.candidate.identity.novel.id)).size,
    payloadBytes: targets.reduce((sum,target)=>sum+target.snapshot.payloadBytes,0), skipped: Object.freeze(skipped) });
}
