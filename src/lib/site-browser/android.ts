import {
  androidScraperCurrentOrigin,
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
  boundsFor: (node) => rectBounds(node),
  currentOrigin: async (sourceId) => androidScraperCurrentOrigin(sourceId),
  setBounds: async (bounds, _url, sourceId) => {
    if (!sourceId) return;
    androidScraperSetBounds(sourceId, bounds, getScraperUserAgent());
  },
  navigate: async (sourceId, url, options) => {
    await androidScraperNavigate(sourceId, url, getScraperUserAgent(), {
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  },
  hide: async () => {
    androidScraperHide();
  },
};
