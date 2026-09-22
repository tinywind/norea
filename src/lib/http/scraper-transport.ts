import { invoke } from "@tauri-apps/api/core";
import { getSourceRequestTimeoutMs } from "../../store/browse";
import { getScraperUserAgent } from "../../store/user-agent";
import { REQUEST_CANCELLED_ERROR, requestAbortedError } from "../abort";
import { cancelAndroidScraperExecutor } from "../android-scraper";
import { type ScraperExecutorId } from "../tasks/scraper-queue";
import { isAndroidRuntime } from "../tauri-runtime";
import { type FetchInitWire, type FetchResultWire } from "./types";

function headerUserAgent(
  headers: Record<string, string> | undefined,
): string | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "user-agent") {
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    }
  }
  return null;
}

export function scraperUserAgent(
  headers: Record<string, string> | undefined,
): string | null {
  return headerUserAgent(headers) ?? getScraperUserAgent();
}

export function requestTimeoutMs(timeoutMs: number | undefined): number {
  const numeric =
    typeof timeoutMs === "number" ? timeoutMs : getSourceRequestTimeoutMs();
  if (!Number.isFinite(numeric)) return getSourceRequestTimeoutMs();
  return Math.max(1, Math.round(numeric));
}

export async function awaitScraperInvoke<T>(
  request: Promise<T>,
  signal: AbortSignal | undefined,
  scraperExecutor: ScraperExecutorId,
): Promise<T> {
  if (!signal) return request;
  if (signal.aborted) throw requestAbortedError();
  let abortListener: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      void cancelScraperExecutor(scraperExecutor);
      reject(requestAbortedError());
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  try {
    return await Promise.race([request, abort]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    request.catch(() => undefined);
  }
}

export async function cancelScraperExecutor(
  executor: ScraperExecutorId,
): Promise<boolean> {
  if (isAndroidRuntime()) {
    return cancelAndroidScraperExecutor(REQUEST_CANCELLED_ERROR, executor);
  }
  try {
    return await invoke<boolean>("scraper_cancel_executor", {
      message: REQUEST_CANCELLED_ERROR,
      queue: executor,
    });
  } catch (error) {
    console.warn("[plugin-fetch] cancel failed", {
      error,
      scraperExecutor: executor,
    });
    return false;
  }
}

interface DesktopWebviewFetchRequest {
  readonly url: string;
  readonly init: FetchInitWire;
  readonly contextUrl: string | null;
  readonly userAgent: string | null;
  readonly sourceId: string | undefined;
  readonly scraperExecutor: ScraperExecutorId;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

export async function desktopWebviewFetch({
  url,
  init,
  contextUrl,
  userAgent,
  sourceId,
  scraperExecutor,
  timeoutMs,
  signal,
}: DesktopWebviewFetchRequest): Promise<FetchResultWire> {
  if (signal?.aborted) {
    throw requestAbortedError();
  }

  const request = invoke<FetchResultWire>("webview_fetch", {
    url,
    init,
    contextUrl,
    userAgent,
    queue: scraperExecutor,
    ...(sourceId ? { sourceId } : {}),
    timeoutMs,
  });
  if (!signal) return request;

  let abortListener: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      void cancelScraperExecutor(scraperExecutor);
      reject(requestAbortedError());
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });

  try {
    return await Promise.race([request, abort]);
  } catch (error) {
    if (signal.aborted) throw requestAbortedError();
    throw error;
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    request.catch(() => undefined);
  }
}
