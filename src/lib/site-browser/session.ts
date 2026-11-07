import { androidScraperResetSiteData } from "../android-scraper";
import { isAndroidRuntime } from "../tauri-runtime";

/** Reports the installed WebView provider's native, site-scoped deletion support. */
export function canResetSourceSiteData(): boolean {
  return isAndroidRuntime()
    && typeof window !== "undefined"
    && window.__NoreaAndroidScraper?.canResetSiteData?.() === true;
}

/** Environment rotation needs both document-start scripts and native UA metadata. */
export function canRotateBrowserFingerprint(): boolean {
  return isAndroidRuntime()
    && typeof window !== "undefined"
    && window.__NoreaAndroidScraper?.canRotateFingerprint?.() === true;
}

/**
 * Removes the affected site's browser data from the shared site profile.
 * The recovery owner keeps the failure hold until deletion completes and its
 * persisted retry budget permits another attempt.
 */
export async function resetSourceSiteData(sourceId: string, url: string): Promise<void> {
  if (!sourceId.trim()) throw new Error("A source is required to reset site data.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The site data reset URL is invalid.");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw new Error("Site data can only be reset for an HTTP or HTTPS site.");
  }
  if (!canResetSourceSiteData()) {
    throw new Error("This WebView provider does not support site data reset.");
  }
  await androidScraperResetSiteData(parsed.origin, sourceId);
}
