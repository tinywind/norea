import { isAbortError } from "../abort";
import { androidWebviewFetch } from "../android-scraper";
import {
  activeScraperExecutor,
  activeScraperExecutorSignal,
} from "../tasks/scraper-queue";
import { isAndroidRuntime } from "../tauri-runtime";
import { redactUrlForLog } from "../url-log";
import { takeCapturedMediaResponse } from "./captured-media";
import { fetchErrorMessage } from "./diagnostics";
import { toWireInit } from "./request";
import { checkedResponseFromWire, sourceAccessFallbackUrl } from "./response";
import {
  desktopWebviewFetch,
  requestTimeoutMs,
  scraperUserAgent,
} from "./scraper-transport";
import { type FetchResultWire, type PluginHttpInit } from "./types";

async function pluginFetchInternal(
  url: string,
  init: PluginHttpInit = {},
): Promise<Response> {
  const wireInit = toWireInit(init);
  const contextUrl = init.contextUrl ?? null;
  const userAgent = scraperUserAgent(wireInit.headers);
  const scraperExecutor =
    init.scraperExecutor ?? activeScraperExecutor(init.sourceId);
  const signal = init.signal ?? activeScraperExecutorSignal(scraperExecutor);
  const timeoutMs = requestTimeoutMs(init.timeoutMs);
  let result: FetchResultWire;
  try {
    result = isAndroidRuntime()
      ? await androidWebviewFetch(
          url,
          wireInit,
          contextUrl,
          userAgent,
          init.sourceId,
          scraperExecutor,
          timeoutMs,
          signal,
          init.priority,
        )
      : await desktopWebviewFetch({
          url,
          init: wireInit,
          contextUrl,
          userAgent,
          sourceId: init.sourceId,
          scraperExecutor,
          timeoutMs,
          signal,
        });
  } catch (error) {
    if (!isAbortError(error)) {
      console.error("[plugin-fetch] failed", {
        contextUrl: contextUrl ? redactUrlForLog(contextUrl) : null,
        error: fetchErrorMessage(error),
        scraperExecutor,
        sourceId: init.sourceId,
        url: redactUrlForLog(url),
      });
    }
    throw error;
  }
  return checkedResponseFromWire(
    result,
    sourceAccessFallbackUrl(url, init),
    signal,
  );
}

export async function pluginFetch(
  url: string,
  init: PluginHttpInit = {},
): Promise<Response> {
  return pluginFetchInternal(url, init);
}

export async function pluginMediaFetch(
  url: string,
  init: PluginHttpInit = {},
): Promise<Response> {
  const scraperExecutor =
    init.scraperExecutor ?? activeScraperExecutor(init.sourceId);
  const capturedResponse = await takeCapturedMediaResponse(
    url,
    init,
    scraperExecutor,
  );
  if (capturedResponse) return capturedResponse;
  return pluginFetchInternal(url, init);
}

export async function pluginFetchText(
  url: string,
  init: PluginHttpInit = {},
): Promise<string> {
  const response = await pluginFetch(url, init);
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} on ${redactUrlForLog(url)}`,
    );
  }
  return response.text();
}
