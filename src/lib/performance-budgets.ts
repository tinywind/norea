const BYTES_PER_MIB = 1024 * 1024;

export const MAX_INLINE_IPC_BYTES = 128 * BYTES_PER_MIB;
export const MAX_UPDATE_BYTES = 512 * BYTES_PER_MIB;
export const MAX_BACKUP_ARCHIVE_BYTES = 2 * 1024 * BYTES_PER_MIB;
export const MAX_ZIP_ENTRY_BYTES = 256 * BYTES_PER_MIB;
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * BYTES_PER_MIB;
export const MAX_ROUTE_QUERY_ROWS = 500;
export const MAX_SCHEDULER_MATERIALIZED_TASKS = 500;
export const MAX_BACKFILL_PER_RUN = 50;
export const MAX_CHAPTER_BULK_INPUT_ROWS = MAX_ROUTE_QUERY_ROWS * 100;
export const MAX_CHAPTER_TITLE_BYTES = 8 * 1024;
export const MAX_CHAPTER_URL_BYTES = 32 * 1024;

export const PERFORMANCE_BUDGETS = {
  maxInlineIpcBytes: MAX_INLINE_IPC_BYTES,
  maxUpdateBytes: MAX_UPDATE_BYTES,
  maxBackupArchiveBytes: MAX_BACKUP_ARCHIVE_BYTES,
  maxZipEntryBytes: MAX_ZIP_ENTRY_BYTES,
  maxZipTotalUncompressedBytes: MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
  maxRouteQueryRows: MAX_ROUTE_QUERY_ROWS,
  maxSchedulerMaterializedTasks: MAX_SCHEDULER_MATERIALIZED_TASKS,
  maxBackfillPerRun: MAX_BACKFILL_PER_RUN,
  maxChapterBulkInputRows: MAX_CHAPTER_BULK_INPUT_ROWS,
  maxChapterTitleBytes: MAX_CHAPTER_TITLE_BYTES,
  maxChapterUrlBytes: MAX_CHAPTER_URL_BYTES,
} as const;

export function clampPositiveIntegerBudget(
  value: number,
  fallback: number,
  max: number,
): number {
  const normalized = Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
  return Math.min(max, normalized);
}

export function clampRouteQueryLimit(
  limit: number,
  fallback: number = MAX_ROUTE_QUERY_ROWS,
): number {
  return clampPositiveIntegerBudget(limit, fallback, MAX_ROUTE_QUERY_ROWS);
}

export function clampBackfillLimit(
  limit: number,
  fallback: number = MAX_BACKFILL_PER_RUN,
): number {
  return clampPositiveIntegerBudget(limit, fallback, MAX_BACKFILL_PER_RUN);
}

export function assertByteBudget(
  byteLength: number,
  maxBytes: number,
  label: string,
): void {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    throw new Error(`${label} size is not available.`);
  }
  if (byteLength > maxBytes) {
    throw new Error(
      `${label} is ${byteLength} bytes, which exceeds the ${maxBytes} byte limit.`,
    );
  }
}

export function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
