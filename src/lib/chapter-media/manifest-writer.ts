import { isMediaAbortError } from "./errors";
import { type ChapterMediaManifestFile } from "./types";

/** Minimum time between progress writes of one chapter's incomplete manifest. */
export const CHAPTER_MEDIA_MANIFEST_PROGRESS_INTERVAL_MS = 5_000;

export interface ChapterMediaManifestWriter {
  /** Records stored media; writes at once when the interval has passed since the last write, otherwise when it ends. */
  progress(): Promise<void>;
  /** Writes unsaved changes now, after any write in flight. */
  flush(): Promise<void>;
}

/**
 * Coalesces one chapter's manifest writes during a media download. Every write
 * publishes the files as they are when it starts, so the manifest only lists
 * assets that were stored first; an unchanged file list is not rewritten.
 */
export function createChapterMediaManifestWriter(
  files: () => ChapterMediaManifestFile[],
  write: (files: ChapterMediaManifestFile[]) => Promise<void>,
): ChapterMediaManifestWriter {
  let written: string | null = null;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let queue = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const writeChanges = (): Promise<void> => {
    const run = queue.then(async () => {
      const current = files();
      const key = JSON.stringify(current);
      if (key === written) return;
      lastWriteAt = Date.now();
      await write(current);
      written = key;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    progress() {
      if (timer !== undefined) return Promise.resolve();
      const delay = lastWriteAt + CHAPTER_MEDIA_MANIFEST_PROGRESS_INTERVAL_MS - Date.now();
      if (delay <= 0) return writeChanges();
      timer = setTimeout(() => {
        timer = undefined;
        writeChanges().catch((error: unknown) => {
          // The final flush retries unsaved changes; cancellation needs no report.
          if (!isMediaAbortError(error)) {
            console.warn("[chapter-media] deferred media manifest write failed", { error });
          }
        });
      }, delay);
      return Promise.resolve();
    },
    flush() {
      clearTimeout(timer);
      timer = undefined;
      return writeChanges();
    },
  };
}
