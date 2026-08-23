import { isAndroidRuntime, isTauriRuntime } from "../tauri-runtime";
import { androidSiteBrowser } from "./android";
import { linuxSiteBrowser } from "./linux";
import type { SiteBrowserPlatformApi } from "./types";
import { webSiteBrowser } from "./web";
import { windowsSiteBrowser } from "./windows";

function isLinuxDesktopRuntime(): boolean {
  return (
    isTauriRuntime() &&
    !isAndroidRuntime() &&
    typeof navigator !== "undefined" &&
    /\bLinux\b/i.test(navigator.userAgent)
  );
}

function isWindowsDesktopRuntime(): boolean {
  return (
    isTauriRuntime() &&
    !isAndroidRuntime() &&
    typeof navigator !== "undefined" &&
    /\bWindows\b/i.test(navigator.userAgent)
  );
}

export function getSiteBrowserPlatform(): SiteBrowserPlatformApi {
  if (!isTauriRuntime()) return webSiteBrowser;
  if (isAndroidRuntime()) return androidSiteBrowser;
  if (isLinuxDesktopRuntime()) return linuxSiteBrowser;
  if (isWindowsDesktopRuntime()) return windowsSiteBrowser;
  return windowsSiteBrowser;
}

export type {
  SiteBrowserBounds,
  SiteBrowserChromeMode,
  SiteBrowserPlatformApi,
} from "./types";
