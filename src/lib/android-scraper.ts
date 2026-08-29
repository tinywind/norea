import { isAndroidRuntime } from "./tauri-runtime";
import type { ScraperExecutorId } from "./tasks/scraper-queue";
import type {
  ChapterPageCacheEntry,
  ChapterPageCachePolicy,
} from "./webview-cache";

interface AndroidScraperBridge {
  cancel?(payload: string): void;
  cancelBackground?(payload: string): void;
  clearCache(payload: string): void;
  clearCookies(payload: string): void;
  currentOrigin(payload: string): void;
  fetch(payload: string): void;
  extract(payload: string): void;
  hide(): void;
  invalidateChapterPageCache(payload: string): void;
  navigate(payload: string): void;
  setBounds(payload: string): void;
}

interface AndroidFetchInitWire {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  preferBrowserCache?: boolean;
}

export interface AndroidFetchResultWire {
  status: number;
  statusText: string;
  body?: string;
  bodyBase64?: string;
  headers: Record<string, string>;
  finalUrl: string;
}

interface NativeEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

declare global {
  interface Window {
    __NoreaAndroidScraper?: AndroidScraperBridge;
    __lnrAndroidScraperResolve?: (id: string, payload: string) => void;
  }
}

let nextRequestId = 1;

const pending = new Map<
  string,
  {
    cleanup: () => void;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timeoutId: number;
  }
>();

function requestAbortedError(): DOMException {
  return new DOMException("Request cancelled", "AbortError");
}

function installResolver(): void {
  if (typeof window === "undefined" || window.__lnrAndroidScraperResolve) {
    return;
  }

  window.__lnrAndroidScraperResolve = (id, payload) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.cleanup();

    let envelope: NativeEnvelope<unknown>;
    try {
      envelope = JSON.parse(payload) as NativeEnvelope<unknown>;
    } catch (error) {
      entry.reject(error);
      return;
    }

    if (envelope.ok) {
      entry.resolve(envelope.result);
    } else {
      entry.reject(new Error(envelope.error ?? "Android scraper failed"));
    }
  };
}

function bridge(): AndroidScraperBridge {
  if (!isAndroidRuntime() || typeof window === "undefined") {
    throw new Error("Android scraper bridge is only available on Android");
  }
  const nativeBridge = window.__NoreaAndroidScraper;
  if (!nativeBridge) {
    throw new Error("Android scraper bridge is not available");
  }
  return nativeBridge;
}

function callNative<T>(
  method:
    | "clearCache"
    | "clearCookies"
    | "currentOrigin"
    | "extract"
    | "fetch"
    | "invalidateChapterPageCache"
    | "navigate",
  payload: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  installResolver();
  if (signal?.aborted) return Promise.reject(requestAbortedError());
  const id = `android-scraper-${nextRequestId}`;
  nextRequestId += 1;

  return new Promise<T>((resolve, reject) => {
    let timeoutId = 0;
    let abortListener: (() => void) | undefined;
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    };
    abortListener = () => {
      pending.delete(id);
      cleanup();
      try {
        bridge().cancel?.(
          JSON.stringify({
            id,
            message: "Android scraper request cancelled",
          }),
        );
      } catch {
        // Best-effort native cleanup; the JS abort result is authoritative.
      }
      reject(requestAbortedError());
    };

    timeoutId = window.setTimeout(() => {
      pending.delete(id);
      try {
        bridge().cancel?.(
          JSON.stringify({
            id,
            message: `Android scraper ${String(method)} timed out`,
          }),
        );
      } catch {
        // Best-effort native cleanup; the JS promise timeout is authoritative.
      }
      cleanup();
      reject(new Error(`Android scraper ${String(method)} timed out`));
    }, timeoutMs);

    pending.set(id, {
      cleanup,
      resolve: (value) => resolve(value as T),
      reject,
      timeoutId,
    });
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) {
      abortListener();
      return;
    }

    try {
      bridge()[method](
        JSON.stringify({
          id,
          ...payload,
        }),
      );
    } catch (error) {
      pending.delete(id);
      cleanup();
      reject(error);
    }
  });
}

export function cancelAndroidScraperExecutor(
  message: string,
  executor: ScraperExecutorId,
): boolean {
  if (!isAndroidRuntime() || typeof window === "undefined") return false;
  const nativeBridge = window.__NoreaAndroidScraper;
  if (!nativeBridge?.cancelBackground) return false;
  nativeBridge.cancelBackground(JSON.stringify({ message, queue: executor }));
  return true;
}

export function androidScraperClearCookies(
  sourceId: string,
  url: string,
  executor: ScraperExecutorId,
): Promise<number> {
  return callNative<number>(
    "clearCookies",
    { sourceId, url, queue: executor },
    10_000,
  );
}

export async function androidScraperClearCache(): Promise<void> {
  await callNative<unknown>("clearCache", {}, 30_000);
}

export async function androidScraperInvalidateChapterPageCache(
  entries: readonly ChapterPageCacheEntry[],
): Promise<void> {
  await callNative<unknown>("invalidateChapterPageCache", { entries }, 30_000);
}

export function androidScraperCurrentOrigin(
  sourceId: string,
): Promise<string | null> {
  return callNative<string | null>("currentOrigin", { sourceId }, 5_000);
}

export function androidWebviewFetch(
  url: string,
  init: AndroidFetchInitWire,
  contextUrl: string | null,
  userAgent: string | null,
  sourceId: string | undefined,
  executor: ScraperExecutorId,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AndroidFetchResultWire> {
  return callNative<AndroidFetchResultWire>(
    "fetch",
    {
      url,
      init,
      contextUrl,
      userAgent,
      ...(sourceId ? { sourceId } : {}),
      queue: executor,
      timeoutMs,
    },
    timeoutMs + 5_000,
    signal,
  );
}

export function androidWebviewExtract(
  url: string,
  beforeScript: string | null,
  timeoutMs: number,
  userAgent: string | null,
  sourceId: string | undefined,
  executor: ScraperExecutorId,
  pageCachePolicy?: ChapterPageCachePolicy,
  signal?: AbortSignal,
): Promise<string> {
  return callNative<string>(
    "extract",
    {
      url,
      beforeScript,
      timeoutMs,
      userAgent,
      ...(sourceId ? { sourceId } : {}),
      queue: executor,
      ...(pageCachePolicy ? { pageCachePolicy } : {}),
    },
    timeoutMs + 5_000,
    signal,
  );
}

export function androidScraperSetBounds(
  sourceId: string,
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  },
  userAgent: string | null,
): void {
  const viewport = window.visualViewport;
  bridge().setBounds(
    JSON.stringify({
      ...bounds,
      viewportWidth: viewport?.width ?? window.innerWidth,
      viewportHeight: viewport?.height ?? window.innerHeight,
      sourceId,
      userAgent,
    }),
  );
}

export function androidScraperHide(): void {
  bridge().hide();
}

export function androidScraperNavigate(
  sourceId: string,
  url: string,
  userAgent: string | null,
  options: {
    resetHistory?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return callNative<boolean>(
    "navigate",
    {
      url,
      sourceId,
      userAgent,
      resetHistory: options.resetHistory ?? false,
      timeoutMs,
    },
    timeoutMs + 5_000,
    options.signal,
  );
}
