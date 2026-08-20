import { invoke } from "@tauri-apps/api/core";
import { getScraperUserAgent } from "../store/user-agent";
import { androidScraperClearCookies } from "./android-scraper";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";
import type { ScraperExecutorId } from "./tasks/scraper-queue";

export async function clearPluginCookies(
  url: string,
  executor: ScraperExecutorId,
): Promise<number> {
  if (!isTauriRuntime()) {
    throw new Error("Plugin cookie clearing is only available in the app");
  }
  if (isAndroidRuntime()) {
    return androidScraperClearCookies(url);
  }
  return invoke<number>("scraper_clear_cookies", {
    queue: executor,
    url,
    userAgent: getScraperUserAgent(),
  });
}
