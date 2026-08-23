import { invoke } from "@tauri-apps/api/core";
import { getScraperUserAgent } from "../../store/user-agent";
import { redactUrlForLog, redactUrlsForLog } from "../url-log";
import { invokeDesktopNavigation } from "./desktop-navigation";
import type {
  SiteBrowserBounds,
  SiteBrowserPlatformApi,
} from "./types";

function debugLinuxSiteBrowser(message: string, data?: unknown): void {
  console.debug(`[site-browser:linux] ${message}`, data);
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

export const linuxSiteBrowser: SiteBrowserPlatformApi = {
  name: "linux",
  chromeMode: "react",
  boundsFor: rectBounds,
  currentOrigin: async () =>
    await invoke<string | null>("scraper_current_origin"),
  setBounds: async (bounds, url) => {
    if (!url) {
      debugLinuxSiteBrowser("setBounds skipped: url is empty", { bounds });
      return;
    }
    const args = {
      url,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      userAgent: getScraperUserAgent(),
    };
    debugLinuxSiteBrowser("setBounds invoke", {
      ...args,
      url: redactUrlForLog(url),
    });
    await invoke("scraper_set_bounds", args);
    debugLinuxSiteBrowser("setBounds complete", {
      ...args,
      url: redactUrlForLog(url),
    });
  },
  navigate: async (url, options) => {
    const args = {
      url,
      userAgent: getScraperUserAgent(),
      resetHistory: options?.resetHistory ?? false,
      timeoutMs: options?.timeoutMs ?? null,
    };
    const logArgs = { ...args, url: redactUrlForLog(url) };
    debugLinuxSiteBrowser("navigate invoke", logArgs);
    await invokeDesktopNavigation(args, options?.signal, (error) => {
      debugLinuxSiteBrowser(
        "navigate cancellation failed",
        redactUrlsForLog(error instanceof Error ? error.message : String(error)),
      );
    });
    debugLinuxSiteBrowser("navigate complete", logArgs);
  },
  hide: async () => {
    debugLinuxSiteBrowser("hide invoke");
    await invoke("scraper_hide");
    debugLinuxSiteBrowser("hide complete");
  },
};
