import { invoke } from "@tauri-apps/api/core";
import { androidScraperResetVpnSession } from "./android-scraper";
import { isAndroidRuntime } from "./tauri-runtime";

export async function resetPluginVpnBrowserSession(): Promise<void> {
  if (isAndroidRuntime()) await androidScraperResetVpnSession();
  else await invoke("scraper_reset_vpn_session");
}
