import { isAbortError } from "../abort";
import { withNetworkRequest } from "../network";
import { normalizeSourceAccessRequiredError } from "../plugins/source-access";
import { checkPluginVpnHealth } from "../plugin-vpn";
import {
  getLastReadyPluginVpnProfileHash,
  waitForPluginVpnReady,
} from "../plugin-vpn-traffic";
import { androidWebviewFetch } from "../android-scraper";
import { usePluginVpnStore } from "../../store/plugin-vpn";
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

const RETRYABLE_VPN_TUNNEL_FAILURE =
  /ERR_TUNNEL_CONNECTION_FAILED|VPN DNS lookup timed out|VPN TCP connection(?: attempt)? timed out|VPN tunnel stopped carrying traffic|plugin VPN connection is (?:unavailable|starting|stopping|switching|reconnecting)/i;

function isRetryableVpnTunnelFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_VPN_TUNNEL_FAILURE.test(message);
}

async function pluginFetchInternal(
  url: string,
  init: PluginHttpInit = {},
  ownerSignal?: AbortSignal,
): Promise<Response> {
  const wireInit = toWireInit(init);
  const contextUrl = init.contextUrl ?? null;
  const userAgent = scraperUserAgent(wireInit.headers);
  const scraperExecutor =
    init.scraperExecutor ?? activeScraperExecutor(init.sourceId);
  const signal = init.signal ?? activeScraperExecutorSignal(scraperExecutor);
  const timeoutMs = requestTimeoutMs(init.timeoutMs);
  const canRecoverForegroundVpn =
    !scraperExecutor?.startsWith("vpn:") &&
    typeof checkPluginVpnHealth === "function";
  let result!: FetchResultWire;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForPluginVpnReady(signal, init.vpnReadyDeadline, scraperExecutor);
    const profileHashBefore = getLastReadyPluginVpnProfileHash();
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
            priority: init.priority,
            ownerSignal,
          });
      break;
    } catch (error) {
      if (
        attempt === 0 &&
        canRecoverForegroundVpn &&
        !isAbortError(error) &&
        !signal?.aborted &&
        usePluginVpnStore.getState().enabled &&
        isRetryableVpnTunnelFailure(error)
      ) {
        const checked = await checkPluginVpnHealth(true).catch(() => null);
        const switchedProfile =
          checked?.phase === "connected" &&
          profileHashBefore !== null &&
          checked.profile?.hash !== undefined &&
          checked.profile.hash !== profileHashBefore;
        if (checked && (checked.phase !== "connected" || switchedProfile) && !signal?.aborted) {
          continue;
        }
      }
      if (!isAbortError(error)) {
        console.error("[plugin-fetch] failed", {
          contextUrl: contextUrl ? redactUrlForLog(contextUrl) : null,
          error: fetchErrorMessage(error),
          scraperExecutor,
          sourceId: init.sourceId,
          url: redactUrlForLog(url),
        });
      }
      throw normalizeSourceAccessRequiredError(error, sourceAccessFallbackUrl(url, init)) ?? error;
    }
  }
  return checkedResponseFromWire(
    result,
    url,
    sourceAccessFallbackUrl(url, init),
    signal,
  );
}

export async function pluginFetch(
  url: string,
  init: PluginHttpInit = {},
): Promise<Response> {
  const signal = init.signal ?? activeScraperExecutorSignal(
    init.scraperExecutor ?? activeScraperExecutor(init.sourceId),
  );
  return withNetworkRequest(signal, (networkSignal) =>
    pluginFetchInternal(url, { ...init, signal: networkSignal }, signal));
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
  return pluginFetch(url, init);
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
