import { invoke } from "@tauri-apps/api/core";
import { getScraperUserAgent } from "../../store/user-agent";
import { redactUrlForLog, redactUrlsForLog } from "../url-log";
import { invokeDesktopNavigation } from "./desktop-navigation";
import type { SiteBrowserBounds, SiteBrowserPlatformApi } from "./types";

function debugWindowsSiteBrowser(message: string, data?: unknown): void {
  console.debug(`[site-browser:windows] ${message}`, data);
}

function rectBounds(node: HTMLDivElement | null): SiteBrowserBounds | null {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function invokeArgs(bounds: SiteBrowserBounds, url: string, sourceId: string): {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  userAgent: string | null;
  sourceId: string;
} {
  return {
    url,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    userAgent: getScraperUserAgent(),
    sourceId,
  };
}

export const windowsSiteBrowser: SiteBrowserPlatformApi = {
  name: "windows",
  boundsFor: rectBounds,
  currentOrigin: async (sourceId) =>
    await invoke<string | null>("scraper_current_origin", { sourceId }),
  setBounds: async (bounds, url, sourceId) => {
    if (!url || !sourceId) {
      debugWindowsSiteBrowser("setBounds skipped: source or url is empty", {
        bounds,
      });
      return;
    }
    const args = invokeArgs(bounds, url, sourceId);
    const logArgs = { ...args, url: redactUrlForLog(url) };
    debugWindowsSiteBrowser("setBounds invoke", logArgs);
    await invoke("scraper_set_bounds", args);
    debugWindowsSiteBrowser("setBounds complete", logArgs);
  },
  navigate: async (sourceId, url, options) => {
    const args = {
      url,
      userAgent: getScraperUserAgent(),
      resetHistory: options?.resetHistory ?? false,
      sourceId,
      timeoutMs: options?.timeoutMs ?? null,
    };
    const logArgs = { ...args, url: redactUrlForLog(url) };
    debugWindowsSiteBrowser("navigate invoke", logArgs);
    await invokeDesktopNavigation(args, options?.signal, (error) => {
      debugWindowsSiteBrowser(
        "navigate cancellation failed",
        redactUrlsForLog(error instanceof Error ? error.message : String(error)),
      );
    });
    debugWindowsSiteBrowser("navigate complete", logArgs);
  },
  hide: async () => {
    debugWindowsSiteBrowser("hide invoke");
    await invoke("scraper_hide");
    debugWindowsSiteBrowser("hide complete");
  },
};
