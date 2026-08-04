import { invoke } from "@tauri-apps/api/core";
import { getScraperUserAgent } from "../../store/user-agent";
import { invokeDesktopNavigation } from "./desktop-navigation";
import type {
  SiteBrowserBounds,
  SiteBrowserControlMessage,
  SiteBrowserPlatformApi,
} from "./types";

function debugLinuxSiteBrowser(message: string, data?: unknown): void {
  console.debug(`[site-browser:linux] ${message}`, data);
}

function fullWindowBounds(): SiteBrowserBounds {
  const bounds = {
    x: 0,
    y: 0,
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
  };
  debugLinuxSiteBrowser("bounds measured from window", {
    bounds,
    viewport: {
      height: window.innerHeight,
      outerHeight: window.outerHeight,
      outerWidth: window.outerWidth,
      visualHeight: window.visualViewport?.height ?? null,
      visualWidth: window.visualViewport?.width ?? null,
      width: window.innerWidth,
    },
  });
  return bounds;
}

export const linuxSiteBrowser: SiteBrowserPlatformApi = {
  name: "linux",
  chromeMode: "in-page",
  boundsFor: () => fullWindowBounds(),
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
    debugLinuxSiteBrowser("setBounds invoke", args);
    await invoke("scraper_set_bounds", args);
    debugLinuxSiteBrowser("setBounds complete", args);
  },
  navigate: async (url, options) => {
    const args = {
      url,
      userAgent: getScraperUserAgent(),
      resetHistory: options?.resetHistory ?? false,
      timeoutMs: options?.timeoutMs ?? null,
    };
    debugLinuxSiteBrowser("navigate invoke", args);
    await invokeDesktopNavigation(args, options?.signal, (error) => {
      debugLinuxSiteBrowser("navigate cancellation failed", error);
    });
    debugLinuxSiteBrowser("navigate complete", args);
  },
  hide: async () => {
    debugLinuxSiteBrowser("hide invoke");
    await invoke("scraper_hide");
    debugLinuxSiteBrowser("hide complete");
  },
  pollControlMessage: async () =>
    await invoke<SiteBrowserControlMessage | null>(
      "scraper_poll_control_message",
    ),
};
