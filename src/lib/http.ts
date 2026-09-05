import { invoke } from "@tauri-apps/api/core";
import {
  androidWebviewFetch,
  cancelAndroidScraperExecutor,
} from "./android-scraper";
import { isAndroidRuntime, isWindowsRuntime } from "./tauri-runtime";
import { cancelNativeStream } from "./native-stream";
import { getSourceRequestTimeoutMs } from "../store/browse";
import { getScraperUserAgent } from "../store/user-agent";
import {
  isSourceAccessRequiredError,
  sourceAccessErrorFromEnvelope,
} from "./plugins/source-access";
import { redactUrlForLog, redactUrlsForLog } from "./url-log";
import {
  activeScraperExecutor,
  activeScraperExecutorSignal,
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
  /** Host-trusted source URL used only to attribute manual-action failures. */
  sourceAccessUrl?: string;
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
  cloudflareChallenge?: boolean;
  headers: Record<string, string>;
  finalUrl: string;
}

export interface CapturedMediaHandle {
  bodyBytes: number;
  bodyHandle: string;
  cloudflareChallenge?: boolean;
  finalUrl: string;
  headers: Record<string, string>;
  status: number;
  statusText: string;
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
const BASE64_DECODE_CHUNK_SIZE = 0x8000;
const BASE64_ENCODE_CHUNK_SIZE = 0x6000;
const BASE64_EVENT_LOOP_YIELD_INTERVAL = 16;
const CLOUDFLARE_BODY_INSPECTION_BYTES = 512 * 1024;

function resolveContextUrl(
  contextUrl: ContextUrlProvider | undefined,
): string | undefined {
  return typeof contextUrl === "function" ? contextUrl() : contextUrl;
}

export function requestAbortedError(): DOMException {
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

function decodeBase64Chunk(bodyBase64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(bodyBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

async function decodeBase64Body(
  bodyBase64: string,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (
    let offset = 0;
    offset < bodyBase64.length;
    offset += BASE64_DECODE_CHUNK_SIZE
  ) {
    if (signal?.aborted) throw requestAbortedError();
    chunks.push(
      decodeBase64Chunk(
        bodyBase64.slice(offset, offset + BASE64_DECODE_CHUNK_SIZE),
      ),
    );
    if (
      chunks.length % BASE64_EVENT_LOOP_YIELD_INTERVAL === 0 &&
      offset + BASE64_DECODE_CHUNK_SIZE < bodyBase64.length
    ) {
      await yieldToEventLoop();
    }
  }
  return chunks;
}

async function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < bytes.length;
    offset += BASE64_ENCODE_CHUNK_SIZE
  ) {
    chunks.push(
      btoa(
        String.fromCharCode(
          ...bytes.subarray(offset, offset + BASE64_ENCODE_CHUNK_SIZE),
        ),
      ),
    );
    if (
      chunks.length % BASE64_EVENT_LOOP_YIELD_INTERVAL === 0 &&
      offset + BASE64_ENCODE_CHUNK_SIZE < bytes.length
    ) {
      await yieldToEventLoop();
    }
  }
  return chunks.join("");
}

async function bodyFromWire(
  result: FetchResultWire,
  signal?: AbortSignal,
): Promise<BodyInit> {
  if (result.bodyBase64 !== undefined) {
    return new Blob(await decodeBase64Body(result.bodyBase64, signal));
  }
  return result.body ?? "";
}

async function responseFromWire(
  result: FetchResultWire,
  signal?: AbortSignal,
): Promise<Response> {
  const response = new Response(await bodyFromWire(result, signal), {
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

function wireHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) return value;
  }
  return undefined;
}

function wireTextBody(result: FetchResultWire): string {
  if (result.body !== undefined) return result.body;
  if (result.bodyBase64 === undefined) return "";
  try {
    const encodedLength = Math.ceil(CLOUDFLARE_BODY_INSPECTION_BYTES / 3) * 4;
    return new TextDecoder().decode(
      decodeBase64Chunk(result.bodyBase64.slice(0, encodedLength)),
    );
  } catch {
    return "";
  }
}

function isCloudflareChallengeResponse(result: FetchResultWire): boolean {
  if (result.cloudflareChallenge) return true;
  if (wireHeader(result.headers, "cf-mitigated")?.toLowerCase() === "challenge") {
    return true;
  }
  const contentType = wireHeader(result.headers, "content-type")?.toLowerCase();
  if (!contentType?.includes("text/html")) return false;
  const body = wireTextBody(result).slice(
    0,
    CLOUDFLARE_BODY_INSPECTION_BYTES,
  );
  return (
    /\/cdn-cgi\/challenge-platform\//i.test(body) ||
    /\b(?:cf-chl-|__cf_chl_)/i.test(body) ||
    /id=["']challenge-(?:form|running|stage)["']/i.test(body) ||
    (/cloudflare ray id/i.test(body) &&
      /attention required|sorry, you have been blocked/i.test(body))
  );
}

function cloudflareAccessError(
  result: FetchResultWire,
  requestUrl: string,
): Error | null {
  if (!isCloudflareChallengeResponse(result)) return null;
  return sourceAccessErrorFromEnvelope(
    {
      ok: false,
      code: "manual-action-required",
      error: "Cloudflare verification is required.",
      challenge: {
        kind: "cloudflare",
        url: result.finalUrl || requestUrl,
      },
    },
    requestUrl,
  );
}

async function checkedResponseFromWire(
  result: FetchResultWire,
  requestUrl: string,
  signal?: AbortSignal,
): Promise<Response> {
  const accessError = cloudflareAccessError(result, requestUrl);
  if (accessError) throw accessError;
  return responseFromWire(result, signal);
}

function sourceAccessFallbackUrl(url: string, init: HttpInit): string {
  return init.sourceAccessUrl ?? init.contextUrl ?? url;
}

function capturedMediaRequestIsEligible(init: HttpInit): boolean {
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

async function awaitScraperInvoke<T>(
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

async function takeCapturedMediaResponse(
  url: string,
  init: HttpInit,
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
  init: HttpInit = {},
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

function mediaRequestHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function mediaRequestContextHost(contextUrl: string | undefined): string {
  if (!contextUrl) return "";
  try {
    return new URL(contextUrl).host;
  } catch {
    return "";
  }
}

function fetchErrorMessage(error: unknown): string {
  return redactUrlsForLog(
    error instanceof Error ? error.message : String(error),
  );
}

function mediaRequestLogContext(
  url: string,
  init: HttpInit,
  scraperExecutor: ScraperExecutorId,
  status?: number,
): Record<string, number | string | undefined> {
  return {
    contextHost: mediaRequestContextHost(init.contextUrl),
    host: mediaRequestHost(url),
    sanitizedUrl: redactUrlForLog(url),
    scraperExecutor,
    sourceId: init.sourceId,
    status,
  };
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

async function desktopWebviewFetch(
  url: string,
  init: FetchInitWire,
  contextUrl: string | null,
  userAgent: string | null,
  sourceId: string | undefined,
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
      `HTTP ${response.status} ${response.statusText} on ${redactUrlForLog(url)}`,
    );
  }
  return response.text();
}

/**
 * Plugin-scraper-facing HTTP fetch.
 *
 * Every request is routed through the source-profile in-app WebView
 * (see `src-tauri/src/scraper.rs`). That gives us a real browser's
 * TLS fingerprint, Sec-Fetch-* headers, User-Agent and cookie jar.
 * Cloudflare, JA3-fingerprinting CDNs and login-walled sites accept
 * it the same way they accept any browser tab. There is no host-side
 * cookie store: each source's WebView profile owns its jar.
 *
 * The response is reconstituted into a standard `Response` object so
 * callers keep the familiar fetch-style API. `Response.url` is patched
 * on so plugins that follow redirects can still see the final URL.
 */
async function pluginFetchInternal(
  url: string,
  init: HttpInit = {},
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
        )
      : await desktopWebviewFetch(
          url,
          wireInit,
          contextUrl,
          userAgent,
          init.sourceId,
          scraperExecutor,
          timeoutMs,
          signal,
        );
  } catch (error) {
    if (!isRequestAbortError(error)) {
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
  init: HttpInit = {},
): Promise<Response> {
  return pluginFetchInternal(url, init);
}

/**
 * Fetch chapter-local media. A response captured during page navigation is
 * reused first, followed by a normal fetch in the same source-profile WebView.
 */
export async function pluginMediaFetch(
  url: string,
  init: HttpInit = {},
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
      `HTTP ${response.status} ${response.statusText} on ${redactUrlForLog(url)}`,
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
