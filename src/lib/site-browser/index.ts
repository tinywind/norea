import {
  isAndroidRuntime,
  isTauriRuntime,
  isWindowsRuntime,
} from "../tauri-runtime";
import { androidSiteBrowser } from "./android";
import type { SiteBrowserPlatformApi } from "./types";
import { webSiteBrowser } from "./web";
import { windowsSiteBrowser } from "./windows";

export function getSiteBrowserPlatform(): SiteBrowserPlatformApi {
  if (!isTauriRuntime()) return webSiteBrowser;
  if (isAndroidRuntime()) return androidSiteBrowser;
  if (isWindowsRuntime()) return windowsSiteBrowser;
  throw new Error("Site browser is unavailable on this platform.");
}

export type {
  SiteBrowserBounds,
  SiteBrowserPlatformApi,
} from "./types";
