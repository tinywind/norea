import { invoke } from "@tauri-apps/api/core";
import { getScraperUserAgent } from "../../store/user-agent";
import { invokeDesktopNavigation } from "./desktop-navigation";
import type {
  SiteBrowserBounds,
  SiteBrowserControlMessage,
  SiteBrowserPlatformApi,
} from "./types";

function debugWindowsSiteBrowser(message: string, data?: unknown): void {
  console.debug(`[site-browser:windows] ${message}`, data);
}

function fullWindowBounds(): SiteBrowserBounds {
  const bounds = {
    x: 0,
    y: 0,
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
  };
  debugWindowsSiteBrowser("bounds measured from window", {
    bounds,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      visualWidth: window.visualViewport?.width ?? null,
      visualHeight: window.visualViewport?.height ?? null,
    },
  });
  return bounds;
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

function invokeArgs(bounds: SiteBrowserBounds, url: string): {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  userAgent: string | null;
} {
  return {
    url,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    userAgent: getScraperUserAgent(),
  };
}

export const windowsSiteBrowser: SiteBrowserPlatformApi = {
  name: "windows",
  chromeMode: "react",
  boundsFor: (node) => rectBounds(node) ?? fullWindowBounds(),
  setBounds: async (bounds, url) => {
    if (!url) {
      debugWindowsSiteBrowser("setBounds skipped: url is empty", { bounds });
      return;
    }
    const args = invokeArgs(bounds, url);
    debugWindowsSiteBrowser("setBounds invoke", args);
    await invoke("scraper_set_bounds", args);
    debugWindowsSiteBrowser("setBounds complete", args);
  },
  navigate: async (url, options) => {
    const args = {
      url,
      userAgent: getScraperUserAgent(),
      resetHistory: options?.resetHistory ?? false,
      timeoutMs: options?.timeoutMs ?? null,
    };
    debugWindowsSiteBrowser("navigate invoke", args);
    await invokeDesktopNavigation(args, options?.signal, (error) => {
      debugWindowsSiteBrowser("navigate cancellation failed", error);
    });
    debugWindowsSiteBrowser("navigate complete", args);
  },
  hide: async () => {
    debugWindowsSiteBrowser("hide invoke");
    await invoke("scraper_hide");
    debugWindowsSiteBrowser("hide complete");
  },
  pollControlMessage: async () =>
    await invoke<SiteBrowserControlMessage | null>(
      "scraper_poll_control_message",
    ),
};
