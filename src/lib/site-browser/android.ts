import {
  androidScraperHide,
  androidScraperNavigate,
  androidScraperSetBounds,
} from "../android-scraper";
import { getScraperUserAgent } from "../../store/user-agent";
import type { SiteBrowserBounds, SiteBrowserPlatformApi } from "./types";

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

export const androidSiteBrowser: SiteBrowserPlatformApi = {
  name: "android",
  chromeMode: "react",
  boundsFor: (node) => rectBounds(node),
  setBounds: async (bounds) => {
    androidScraperSetBounds(bounds, getScraperUserAgent());
  },
  navigate: async (url, options) => {
    await androidScraperNavigate(url, getScraperUserAgent(), {
      resetHistory: options?.resetHistory ?? false,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  },
  hide: async () => {
    androidScraperHide();
  },
  pollControlMessage: async () => null,
};
