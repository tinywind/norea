import { invoke } from "@tauri-apps/api/core";
import { androidScraperClearCache } from "./android-scraper";
import {
  clearPersistentSourceCoverCache,
  invalidateAllNovelCoverSources,
} from "./novel-cover-storage";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";

export async function clearWebViewCache(): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("WebView cache clearing is only available in the app");
  }
  if (isAndroidRuntime()) {
    await androidScraperClearCache();
  } else {
    await invoke("scraper_clear_cache");
  }
  await clearPersistentSourceCoverCache();
  invalidateAllNovelCoverSources();
}
