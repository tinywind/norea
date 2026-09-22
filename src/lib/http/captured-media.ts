import { invoke } from "@tauri-apps/api/core";
import { requestAbortedError } from "../abort";
import { cancelNativeStream } from "../native-stream";
import { isSourceAccessRequiredError } from "../plugins/source-access";
import {
  type ScraperExecutorId,
  activeScraperExecutor,
  activeScraperExecutorSignal,
} from "../tasks/scraper-queue";
import { isWindowsRuntime } from "../tauri-runtime";
import { fetchErrorMessage, mediaRequestLogContext } from "./diagnostics";
import {
  checkedResponseFromWire,
  cloudflareAccessError,
  sourceAccessFallbackUrl,
} from "./response";
import { awaitScraperInvoke, scraperUserAgent } from "./scraper-transport";
import {
  type CapturedMediaHandle,
  type FetchResultWire,
  type PluginHttpInit,
} from "./types";

function capturedMediaRequestIsEligible(init: PluginHttpInit): boolean {
  if (init.method !== undefined && init.method.toUpperCase() !== "GET") {
    return false;
  }
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    const normalizedName = name.toLowerCase();
    if (
      [
        "range",
        "if-match",
        "if-modified-since",
        "if-none-match",
        "if-range",
        "if-unmodified-since",
      ].includes(normalizedName)
    ) {
      return false;
    }
    if (
      normalizedName === "cache-control" &&
      value
        .split(",")
        .some((directive) =>
          ["no-cache", "no-store"].includes(directive.trim().toLowerCase()),
        )
    ) {
      return false;
    }
    if (
      normalizedName === "pragma" &&
      value
        .toLowerCase()
        .split(",")
        .some((directive) => directive.trim() === "no-cache")
    ) {
      return false;
    }
  }
  return true;
}

export async function takeCapturedMediaResponse(
  url: string,
  init: PluginHttpInit,
  scraperExecutor: ScraperExecutorId,
): Promise<Response | null> {
  if (
    !init.sourceId ||
    !isWindowsRuntime() ||
    !capturedMediaRequestIsEligible(init)
  ) {
    return null;
  }
  const signal = init.signal ?? activeScraperExecutorSignal(scraperExecutor);
  if (signal?.aborted) throw requestAbortedError();
  try {
    const result = await awaitScraperInvoke(
      invoke<FetchResultWire | null>("scraper_take_captured_resource", {
        url,
        queue: scraperExecutor,
        userAgent: scraperUserAgent(init.headers),
        ...(init.sourceId ? { sourceId: init.sourceId } : {}),
      }),
      signal,
      scraperExecutor,
    );
    if (result) {
      console.debug("[plugin-media-fetch] captured response used", {
        ...mediaRequestLogContext(url, init, scraperExecutor, result.status),
      });
    }
    return result
      ? await checkedResponseFromWire(
          result,
          sourceAccessFallbackUrl(url, init),
          signal,
        )
      : null;
  } catch (error) {
    if (signal?.aborted) throw requestAbortedError();
    if (isSourceAccessRequiredError(error)) throw error;
    console.debug("[plugin-media-fetch] captured response unavailable", {
      error: fetchErrorMessage(error),
      ...mediaRequestLogContext(url, init, scraperExecutor),
    });
    return null;
  }
}

export async function takeCapturedMediaHandle(
  url: string,
  init: PluginHttpInit = {},
): Promise<CapturedMediaHandle | null> {
  if (
    !init.sourceId ||
    !isWindowsRuntime() ||
    !capturedMediaRequestIsEligible(init)
  ) {
    return null;
  }
  const scraperExecutor =
    init.scraperExecutor ?? activeScraperExecutor(init.sourceId);
  const signal = init.signal ?? activeScraperExecutorSignal(scraperExecutor);
  if (signal?.aborted) throw requestAbortedError();
  try {
    const result = await awaitScraperInvoke(
      invoke<CapturedMediaHandle | null>(
        "scraper_take_captured_resource_handle",
        {
          url,
          queue: scraperExecutor,
          userAgent: scraperUserAgent(init.headers),
          ...(init.sourceId ? { sourceId: init.sourceId } : {}),
        },
      ),
      signal,
      scraperExecutor,
    );
    if (result) {
      const accessError = cloudflareAccessError(
        result,
        sourceAccessFallbackUrl(url, init),
      );
      if (accessError) {
        await cancelNativeStream(result.bodyHandle).catch(() => undefined);
        throw accessError;
      }
      console.debug("[plugin-media-fetch] captured response handle used", {
        ...mediaRequestLogContext(url, init, scraperExecutor, result.status),
        bodyBytes: result.bodyBytes,
      });
    }
    return result;
  } catch (error) {
    if (signal?.aborted) throw requestAbortedError();
    if (isSourceAccessRequiredError(error)) throw error;
    console.debug("[plugin-media-fetch] captured response handle unavailable", {
      error: fetchErrorMessage(error),
      ...mediaRequestLogContext(url, init, scraperExecutor),
    });
    return null;
  }
}
