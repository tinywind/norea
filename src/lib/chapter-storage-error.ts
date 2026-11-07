import { isAbortError } from "./abort";

export class ChapterStorageError extends Error {
  readonly code = "chapter-storage-failed" as const;

  constructor(readonly operation: string, readonly cause: unknown) {
    super(`Chapter storage failed during ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ChapterStorageError";
  }
}

/** Adds local storage context without changing cancellation or an existing storage cause. */
export async function withChapterStorageOperation<T>(operation: string, access: () => Promise<T>): Promise<T> {
  try { return await access(); } catch (error) {
    if (isAbortError(error) || isChapterStorageError(error)) throw error;
    throw new ChapterStorageError(operation, error);
  }
}

export function isChapterStorageError(value: unknown): value is ChapterStorageError {
  return value !== null && typeof value === "object"
    && "code" in value && value.code === "chapter-storage-failed";
}
