import { invoke } from "@tauri-apps/api/core";
import {
  androidScraperClearCache,
  androidScraperInvalidateChapterPageCache,
} from "./android-scraper";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

export type ChapterPageCachePolicy = "prefer-cache" | "reload";

export interface ChapterPageCacheEntry {
  sourceId: string;
  url?: string;
}

const CHAPTER_PAGE_CACHE_INVALIDATION_CHUNK_SIZE = 1_000;

function throwIfCacheInvalidationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ??
    new DOMException("Chapter page cache invalidation was cancelled.", "AbortError")
  );
}

export async function clearWebViewCache(): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("WebView cache clearing is only available in the app");
  }
  if (isAndroidRuntime()) {
    await androidScraperClearCache();
    return;
  }
  await invoke("scraper_clear_cache");
}

export async function invalidateChapterPageCache(
  entries: readonly ChapterPageCacheEntry[],
  signal?: AbortSignal,
): Promise<void> {
  if (entries.length === 0) return;
  if (!isTauriRuntime()) {
    throw new Error("WebView cache invalidation is only available in the app");
  }
  const android = isAndroidRuntime();
  for (
    let offset = 0;
    offset < entries.length;
    offset += CHAPTER_PAGE_CACHE_INVALIDATION_CHUNK_SIZE
  ) {
    throwIfCacheInvalidationAborted(signal);
    const chunk = entries.slice(
      offset,
      offset + CHAPTER_PAGE_CACHE_INVALIDATION_CHUNK_SIZE,
    );
    if (android) {
      await androidScraperInvalidateChapterPageCache(chunk);
    } else {
      await invoke("scraper_invalidate_chapter_page_cache", { entries: chunk });
    }
  }
}
