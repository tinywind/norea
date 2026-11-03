import { enqueueOpenSiteTask } from "../tasks/source-tasks";
import { redactUrlForLog } from "../url-log";
import { getPluginBaseUrl } from "./base-url";
import type { Plugin } from "./types";

/**
 * Opens the plugin's base URL in the site browser overlay. The source-profile
 * scraper WebView owns the browser session, so later plugin fetches reuse it.
 */
export function openPluginSite(plugin: Plugin, title: string): void {
  const url = getPluginBaseUrl(plugin);
  console.debug("[site-browser] open site clicked", {
    url: redactUrlForLog(url),
  });
  void enqueueOpenSiteTask(plugin, url, title).promise.catch(() => undefined);
}
