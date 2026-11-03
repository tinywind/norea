import type { LocalImportReviewItem } from "./local-import-review";

export type LocalImportPhase = "analyzing" | "review" | "importing" | "result";

/** One import request from analysis to the acknowledged result. */
export interface LocalImportBatch {
  attemptedIds: readonly string[];
  id: number;
  items: readonly LocalImportReviewItem[];
  phase: LocalImportPhase;
}

export function startLocalImportBatch(id: number): LocalImportBatch {
  return { attemptedIds: [], id, items: [], phase: "analyzing" };
}

/** Closing waits until analysis and import have finished. */
export function isLocalImportBusy(batch: LocalImportBatch | null): boolean {
  return batch?.phase === "analyzing" || batch?.phase === "importing";
}

/** Applies `update` only while `batch` is still batch `id`, so late results of an older batch are dropped. */
export function updateLocalImportBatch(
  batch: LocalImportBatch | null,
  id: number,
  update: (batch: LocalImportBatch) => LocalImportBatch,
): LocalImportBatch | null {
  return batch?.id === id ? update(batch) : batch;
}

export function beginLocalImport(batch: LocalImportBatch): LocalImportBatch {
  const ready = new Set(
    batch.items.filter((item) => item.status === "ready").map((item) => item.id),
  );
  return {
    ...batch,
    attemptedIds: [...ready],
    items: batch.items.map((item) =>
      ready.has(item.id) ? { ...item, status: "importing" } : item,
    ),
    phase: "importing",
  };
}

export function replaceLocalImportItem(
  batch: LocalImportBatch,
  item: LocalImportReviewItem,
): LocalImportBatch {
  return {
    ...batch,
    items: batch.items.map((current) => (current.id === item.id ? item : current)),
  };
}

export function getLocalImportResultCounts(batch: LocalImportBatch): {
  failed: number;
  imported: number;
  skipped: number;
} {
  const attempted = new Set(batch.attemptedIds);
  const imported = batch.items.filter((item) => item.status === "imported").length;
  return {
    failed: batch.items.filter(
      (item) => attempted.has(item.id) && item.status === "error",
    ).length,
    imported,
    skipped: batch.items.filter((item) => !attempted.has(item.id)).length,
  };
}
