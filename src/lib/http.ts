import { invoke } from "@tauri-apps/api/core";
import {
  androidWebviewFetch,
  cancelAndroidScraperExecutor,
} from "./android-scraper";
import { isAndroidRuntime } from "./tauri-runtime";
import { getSourceRequestTimeoutMs } from "../store/browse";
import { getScraperUserAgent } from "../store/user-agent";
import {
  activeScraperExecutor,
  type ScraperExecutorId,
} from "./tasks/scraper-queue";

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  /**
   * Anything plugin code passes through `fetchApi`. The IPC layer
   * needs a string, so non-string values get serialized in
   * `serializeBody` before they cross the boundary. Plain objects
   * become JSON, URLSearchParams becomes their query-string form,
   * and FormData is dropped to undefined until multipart support
   * lands.
   */
  body?: unknown;
  /** Plugin-owned site origin to prepare in the scraper WebView. */
  contextUrl?: string;
  /** Source id used to infer an executor when no explicit scraper executor is bound. */
  sourceId?: string;
  /** Executor-owned WebView that must execute plugin-owned site traffic. */
  scraperExecutor?: ScraperExecutorId;
  /** Per-request timeout for plugin-owned site traffic. */
  timeoutMs?: number;
  /** Cancels the plugin-owned WebView request when the owning task is aborted. */
  signal?: AbortSignal;
}

export type ContextUrlProvider = string | (() => string);

interface FetchInitWire {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface FetchResultWire {
  status: number;
  statusText: string;
  body?: string;
  bodyBase64?: string;
  headers: Record<string, string>;
  finalUrl: string;
}

interface AppFetchSendResult {
  status: number;
  statusText: string;
  url: string;
  headers: HeadersInit;
  rid: number;
}

const EMPTY_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
const REQUEST_CANCELLED_ERROR = "Request cancelled";
const nativeMediaFallbackHosts = new Set<string>();

function resolveContextUrl(
  contextUrl: ContextUrlProvider | undefined,
): string | undefined {
  return typeof contextUrl === "function" ? contextUrl() : contextUrl;
}

function requestAbortedError(): DOMException {
  return new DOMException(REQUEST_CANCELLED_ERROR, "AbortError");
}

function isRequestAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

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

function scraperUserAgent(
  headers: Record<string, string> | undefined,
): string | null {
  return headerUserAgent(headers) ?? getScraperUserAgent();
}

function serializeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    // Multipart bodies don't survive the IPC string field today.
    // Plugins that rely on multipart fail visibly here rather than
    // silently sending the wrong thing.
    return undefined;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function toWireInit(init: HttpInit): FetchInitWire {
  return {
    method: init.method,
    headers: init.headers ? { ...init.headers } : undefined,
    body: serializeBody(init.body),
  };
}

function requestTimeoutMs(timeoutMs: number | undefined): number {
  const numeric =
    typeof timeoutMs === "number" ? timeoutMs : getSourceRequestTimeoutMs();
  if (!Number.isFinite(numeric)) return getSourceRequestTimeoutMs();
  return Math.max(1, Math.round(numeric));
}

function decodeBase64Body(bodyBase64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(bodyBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
    );
  }
  return btoa(chunks.join(""));
}

function bodyFromWire(result: FetchResultWire): BodyInit {
  if (result.bodyBase64 !== undefined) {
    return new Blob([decodeBase64Body(result.bodyBase64)]);
  }
  return result.body ?? "";
}

function responseFromWire(result: FetchResultWire): Response {
  const response = new Response(bodyFromWire(result), {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  Object.defineProperty(response, "url", {
    value: result.finalUrl,
    configurable: true,
  });
  return response;
}

function mediaFallbackHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function sanitizedFetchUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? url;
  }
}

function mediaFallbackContextHost(contextUrl: string | undefined): string {
  if (!contextUrl) return "";
  try {
    return new URL(contextUrl).host;
  } catch {
    return "";
  }
}

function shouldPreferNativeMediaFetch(url: string, init: HttpInit): boolean {
  const host = mediaFallbackHost(url);
  const contextHost = mediaFallbackContextHost(init.contextUrl);
  return host !== "" && contextHost !== "" && host !== contextHost;
}

function shouldRetryNativeMediaWithBrowser(response: Response): boolean {
  return (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 429 ||
    response.status >= 500
  );
}

function fetchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mediaFallbackLogContext(
  url: string,
  init: HttpInit,
  scraperExecutor: ScraperExecutorId,
  status?: number,
): Record<string, number | string | undefined> {
  return {
    contextHost: mediaFallbackContextHost(init.contextUrl),
    host: mediaFallbackHost(url),
    sanitizedUrl: sanitizedFetchUrl(url),
    scraperExecutor,
    sourceId: init.sourceId,
    status,
  };
}

async function nativeMediaResponse(
  url: string,
  init: HttpInit,
  scraperExecutor: ScraperExecutorId,
): Promise<Response> {
  const wireInit = toWireInit(init);
  const userAgent = scraperUserAgent(wireInit.headers);
  const timeoutMs = requestTimeoutMs(init.timeoutMs);
  console.debug("[plugin-media-fetch] native fetch started", {
    ...mediaFallbackLogContext(url, init, scraperExecutor),
  });
  const result = await nativeMediaFetch(
    url,
    wireInit,
    userAgent,
    timeoutMs,
    init.signal,
  );
  console.debug("[plugin-media-fetch] native fetch finished", {
    ...mediaFallbackLogContext(url, init, scraperExecutor, result.status),
  });
  return responseFromWire(result);
}

async function cancelScraperExecutor(
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

async function desktopWebviewFetch(
  url: string,
  init: FetchInitWire,
  contextUrl: string | null,
  userAgent: string | null,
  scraperExecutor: ScraperExecutorId,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<FetchResultWire> {
  if (signal?.aborted) {
    throw requestAbortedError();
  }

  const request = invoke<FetchResultWire>("webview_fetch", {
    url,
    init,
    contextUrl,
    userAgent,
    queue: scraperExecutor,
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

async function nativeMediaFetch(
  url: string,
  init: FetchInitWire,
  userAgent: string | null,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<FetchResultWire> {
  if (signal?.aborted) {
    throw requestAbortedError();
  }

  const request = invoke<FetchResultWire>("scraper_media_fetch", {
    url,
    init,
    userAgent,
    timeoutMs,
  });
  if (!signal) return request;

  let abortListener: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(requestAbortedError());
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

function encodeAppFetchBody(body: unknown): number[] | null {
  const serialized = serializeBody(body);
  if (serialized === undefined) return null;
  return Array.from(new TextEncoder().encode(serialized));
}

function appFetchHeaders(
  headers: Record<string, string> | undefined,
): [string, string][] {
  return Object.entries(headers ?? {});
}

function concatChunks(
  chunks: Uint8Array<ArrayBuffer>[],
): Uint8Array<ArrayBuffer> {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function readAppFetchBody(
  rid: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  while (true) {
    const data = await invoke<number[]>("plugin:http|fetch_read_body", {
      rid,
    });
    const bytes = new Uint8Array(data);
    if (bytes.byteLength === 0) {
      throw new Error("App fetch body chunk is missing the completion flag.");
    }
    const done = bytes[bytes.byteLength - 1] === 1;
    const chunk = bytes.slice(0, bytes.byteLength - 1);
    if (chunk.byteLength > 0) chunks.push(chunk);
    if (done) break;
  }
  return concatChunks(chunks);
}

export async function appFetch(
  url: string,
  init: HttpInit = {},
): Promise<Response> {
  if (init.signal?.aborted) {
    throw new Error(REQUEST_CANCELLED_ERROR);
  }

  const rid = await invoke<number>("plugin:http|fetch", {
    clientConfig: {
      method: init.method ?? "GET",
      url,
      headers: appFetchHeaders(init.headers),
      data: encodeAppFetchBody(init.body),
    },
  });

  if (init.signal?.aborted) {
    await invoke("plugin:http|fetch_cancel", { rid });
    throw new Error(REQUEST_CANCELLED_ERROR);
  }

  const result = await invoke<AppFetchSendResult>("plugin:http|fetch_send", {
    rid,
  });
  let body: BodyInit | null = null;
  if (!EMPTY_BODY_STATUS.has(result.status)) {
    try {
      body = new Blob([await readAppFetchBody(result.rid)]);
    } catch (error) {
      await invoke("plugin:http|fetch_cancel_body", { rid: result.rid });
      throw error;
    }
  }
  const response = new Response(body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  Object.defineProperty(response, "url", {
    value: result.url,
    configurable: true,
  });
  return response;
}

export async function appFetchText(
  url: string,
  init: HttpInit = {},
): Promise<string> {
  const response = await appFetch(url, init);
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} on ${url}`,
    );
  }
  return response.text();
}

/**
 * Plugin-scraper-facing HTTP fetch.
 *
 * Every request is routed through the persistent in-app WebView
 * (see `src-tauri/src/scraper.rs`). That gives us a real browser's
 * TLS fingerprint, Sec-Fetch-* headers, User-Agent and cookie jar.
 * Cloudflare, JA3-fingerprinting CDNs and login-walled sites accept
 * it the same way they accept any browser tab. There is no host-side
 * cookie store: the WebView owns the jar.
 *
 * The response is reconstituted into a standard `Response` object so
 * callers keep the familiar fetch-style API. `Response.url` is patched
 * on so plugins that follow redirects can still see the final URL.
 */
async function pluginFetchInternal(
  url: string,
  init: HttpInit = {},
  options: { logFailures?: boolean } = {},
): Promise<Response> {
  const logFailures = options.logFailures ?? true;
  const wireInit = toWireInit(init);
  const contextUrl = init.contextUrl ?? null;
  const userAgent = scraperUserAgent(wireInit.headers);
  const scraperExecutor =
    init.scraperExecutor ?? activeScraperExecutor(init.sourceId);
  const timeoutMs = requestTimeoutMs(init.timeoutMs);
  let result: FetchResultWire;
  try {
    result = isAndroidRuntime()
      ? await androidWebviewFetch(
          url,
          wireInit,
          contextUrl,
          userAgent,
          scraperExecutor,
          timeoutMs,
          init.signal,
        )
      : await desktopWebviewFetch(
          url,
          wireInit,
          contextUrl,
          userAgent,
          scraperExecutor,
          timeoutMs,
          init.signal,
        );
  } catch (error) {
    if (logFailures && !isRequestAbortError(error)) {
      console.error("[plugin-fetch] failed", {
        contextUrl,
        error,
        scraperExecutor,
        sourceId: init.sourceId,
        url,
      });
    }
    throw error;
  }
  return responseFromWire(result);
}

export async function pluginFetch(
  url: string,
  init: HttpInit = {},
): Promise<Response> {
  return pluginFetchInternal(url, init);
}

/**
 * Fetch chapter-local media. The browser WebView path is still tried first so
 * ordinary plugin traffic keeps browser session behavior. Some image CDNs allow
 * `<img>` loads but block JS `fetch()` reads; those static media requests fall
 * back to the scraper-owned native media fetch with plugin-declared headers.
 */
export async function pluginMediaFetch(
  url: string,
  init: HttpInit = {},
): Promise<Response> {
  const scraperExecutor =
    init.scraperExecutor ?? activeScraperExecutor(init.sourceId);
  if (shouldPreferNativeMediaFetch(url, init)) {
    let nativeError: unknown;
    try {
      const nativeResponse = await nativeMediaResponse(
        url,
        init,
        scraperExecutor,
      );
      if (!shouldRetryNativeMediaWithBrowser(nativeResponse)) {
        return nativeResponse;
      }
      nativeError = `HTTP ${nativeResponse.status} ${nativeResponse.statusText}`;
      console.warn(
        "[plugin-media-fetch] native fetch returned retryable status; trying WebView",
        {
          ...mediaFallbackLogContext(
            url,
            init,
            scraperExecutor,
            nativeResponse.status,
          ),
          nativeError,
        },
      );
    } catch (error) {
      if (isRequestAbortError(error)) {
        throw error;
      }
      nativeError = error;
      console.warn("[plugin-media-fetch] native fetch failed; trying WebView", {
        ...mediaFallbackLogContext(url, init, scraperExecutor),
        nativeError: fetchErrorMessage(error),
      });
    }

    try {
      return await pluginFetchInternal(url, init, { logFailures: false });
    } catch (browserError) {
      if (isRequestAbortError(browserError)) {
        throw browserError;
      }
      console.warn("[plugin-media-fetch] WebView fallback failed", {
        ...mediaFallbackLogContext(url, init, scraperExecutor),
        browserError: fetchErrorMessage(browserError),
        nativeError: fetchErrorMessage(nativeError),
      });
      throw new Error(
        `Media fetch failed for ${sanitizedFetchUrl(url)}; native: ${fetchErrorMessage(
          nativeError,
        )}; browser: ${fetchErrorMessage(browserError)}`,
        { cause: browserError },
      );
    }
  }

  let browserError: unknown;
  try {
    return await pluginFetchInternal(url, init, { logFailures: false });
  } catch (error) {
    if (isRequestAbortError(error)) {
      throw error;
    }
    browserError = error;
    const host = mediaFallbackHost(url);
    const fallbackKey = host || url;
    if (!nativeMediaFallbackHosts.has(fallbackKey)) {
      nativeMediaFallbackHosts.add(fallbackKey);
      console.debug(
        "[plugin-media-fetch] browser fetch failed; using native media fetch",
        {
          ...mediaFallbackLogContext(url, init, scraperExecutor),
          error: fetchErrorMessage(error),
        },
      );
    }
  }

  const wireInit = toWireInit(init);
  const userAgent = scraperUserAgent(wireInit.headers);
  const timeoutMs = requestTimeoutMs(init.timeoutMs);
  console.debug("[plugin-media-fetch] native fallback started", {
    ...mediaFallbackLogContext(url, init, scraperExecutor),
  });
  try {
    const result = await nativeMediaFetch(
      url,
      wireInit,
      userAgent,
      timeoutMs,
      init.signal,
    );
    console.debug("[plugin-media-fetch] native fallback finished", {
      ...mediaFallbackLogContext(url, init, scraperExecutor, result.status),
    });
    return responseFromWire(result);
  } catch (nativeError) {
    if (isRequestAbortError(nativeError)) {
      throw nativeError;
    }
    console.warn("[plugin-media-fetch] native fallback failed", {
      ...mediaFallbackLogContext(url, init, scraperExecutor),
      browserError: fetchErrorMessage(browserError),
      nativeError: fetchErrorMessage(nativeError),
    });
    throw new Error(
      `Media fetch failed for ${sanitizedFetchUrl(url)}; browser: ${fetchErrorMessage(
        browserError,
      )}; native: ${fetchErrorMessage(nativeError)}`,
      { cause: nativeError },
    );
  }
}

/**
 * Convenience wrapper that resolves to the response body as text.
 * Throws on non-2xx so callers don't have to thread `.ok` checks
 * through every code path.
 */
export async function pluginFetchText(
  url: string,
  init: HttpInit = {},
): Promise<string> {
  const response = await pluginFetch(url, init);
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} on ${url}`,
    );
  }
  return response.text();
}

export function createPluginFetch(
  contextUrl: ContextUrlProvider,
  sourceId?: string,
  scraperExecutor?: ScraperExecutorId,
): (url: string, init?: HttpInit) => Promise<Response> {
  return (url, init = {}) =>
    pluginFetch(url, {
      ...init,
      contextUrl: init.contextUrl ?? resolveContextUrl(contextUrl),
      sourceId: init.sourceId ?? sourceId,
      scraperExecutor: init.scraperExecutor ?? scraperExecutor,
    });
}

export function createPluginFetchText(
  contextUrl: ContextUrlProvider,
  sourceId?: string,
  scraperExecutor?: ScraperExecutorId,
): (url: string, init?: HttpInit) => Promise<string> {
  return (url, init = {}) =>
    pluginFetchText(url, {
      ...init,
      contextUrl: init.contextUrl ?? resolveContextUrl(contextUrl),
      sourceId: init.sourceId ?? sourceId,
      scraperExecutor: init.scraperExecutor ?? scraperExecutor,
    });
}

export function createPluginFetchFile(
  contextUrl?: ContextUrlProvider,
  sourceId?: string,
  scraperExecutor?: ScraperExecutorId,
): (url: string, init?: HttpInit) => Promise<string> {
  return async (url, init = {}) => {
    const response = await pluginMediaFetch(url, {
      ...init,
      contextUrl:
        init.contextUrl ??
        (contextUrl === undefined ? undefined : resolveContextUrl(contextUrl)),
      sourceId: init.sourceId ?? sourceId,
      scraperExecutor: init.scraperExecutor ?? scraperExecutor,
    });
    if (!response.ok) return "";
    return arrayBufferToBase64(await response.arrayBuffer());
  };
}

function normalizeHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const obj: Record<string, string> = {};
    headers.forEach((value, key) => {
      obj[key] = value;
    });
    return obj;
  }
  if (Array.isArray(headers)) {
    const obj: Record<string, string> = {};
    for (const [key, value] of headers) {
      obj[key] = value;
    }
    return obj;
  }
  return headers as Record<string, string>;
}

/**
 * Adapter from the native `fetch(input, init)` signature to
 * `pluginFetch`. Sandboxed plugin code that uses raw `fetch()`
 * during search/listing, novel metadata parsing, update checks, or
 * chapter downloads gets routed through the scraper-WebView-backed
 * IPC the same way explicit `fetchApi` callers are.
 */
export function pluginFetchShim(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return createPluginFetchShim()(input, init);
}

export function createPluginFetchShim(
  contextUrl?: ContextUrlProvider,
  sourceId?: string,
  scraperExecutor?: ScraperExecutorId,
): (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> {
  return (input, init) => {
    const pluginInit = init as
      | (RequestInit & {
          contextUrl?: string;
          scraperExecutor?: ScraperExecutorId;
          sourceId?: string;
          timeoutMs?: number;
        })
      | undefined;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return pluginFetch(url, {
      method: pluginInit?.method,
      headers: normalizeHeaders(pluginInit?.headers),
      body: pluginInit?.body,
      contextUrl: pluginInit?.contextUrl ?? resolveContextUrl(contextUrl),
      sourceId: pluginInit?.sourceId ?? sourceId,
      scraperExecutor: pluginInit?.scraperExecutor ?? scraperExecutor,
      timeoutMs: pluginInit?.timeoutMs,
      signal: pluginInit?.signal ?? undefined,
    });
  };
}
