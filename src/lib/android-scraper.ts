import { requestAbortedError } from "./abort";
import { isAndroidRuntime } from "./tauri-runtime";
import type { ScraperExecutorId } from "./tasks/scraper-queue";
import { androidBridgeAuthority } from "./android-bridge";
import type { VpnDownloadWorkerRef } from "./tasks/vpn-download-types";
import { isVpnDownloadWorkerSlot } from "./tasks/vpn-download-types";

interface AndroidVpnDownloadWorkerBridge {
  capabilities: () => string;
  request: (payload: string) => void;
}

interface AndroidScraperBridge {
  cancel?(payload: string): void;
  cancelBackground?(payload: string): void;
  clearCache(payload: string): void;
  clearCookies(payload: string): void;
  currentOrigin(payload: string): void;
  currentUrl(payload: string): void;
  fetch(payload: string): void;
  extract(payload: string): void;
  hide(): void;
  navigate(payload: string): void;
  setBounds(payload: string): void;
}

interface AndroidFetchInitWire {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
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
    __NoreaAndroidVpnWorkers?: AndroidVpnDownloadWorkerBridge;
    __noreaAndroidScraperResolve?: (id: string, payload: string) => void;
  }
}

let nextRequestId = 1;
const vpnWorkerSources = new Map<string, string>();
type AndroidScraperMethod = "clearCache" | "clearCookies" | "currentOrigin" | "currentUrl" | "extract" | "fetch" | "navigate";
type AndroidWorkerMethod = AndroidScraperMethod | "configureWorker" | "ensureWorker" | "closeWorker" | "showWorker" | "cancel" | "cancelBackground";

function vpnWorkerQueue(worker: VpnDownloadWorkerRef): ScraperExecutorId {
  if (!isVpnDownloadWorkerSlot(worker.slot) || !Number.isSafeInteger(worker.generation) || worker.generation <= 0) {
    throw new Error("Android VPN worker identity is invalid.");
  }
  return `vpn:${worker.slot}:${worker.generation}`;
}

function sendWorkerCommand(method: AndroidWorkerMethod, payload: Record<string, unknown>): void {
  const match = typeof payload.queue === "string" ? /^vpn:([0-9]):([1-9]\d*)$/.exec(payload.queue) : null;
  if (!match || !Number.isSafeInteger(Number(match[2])) || typeof payload.sourceId !== "string" || !payload.sourceId.trim()) {
    throw new Error("Android VPN worker request identity is invalid.");
  }
  const workerBridge = window.__NoreaAndroidVpnWorkers;
  if (!workerBridge) throw new Error("Android VPN worker bridge is unavailable.");
  workerBridge.request(JSON.stringify({ ...payload, method, _bridge: androidBridgeAuthority("vpn.worker") }));
}

function cancelNativeRequest(id: string, payload: Record<string, unknown>, message: string): void {
  if (typeof payload.queue === "string" && payload.queue.startsWith("vpn:")) {
    sendWorkerCommand("cancel", { id, queue: payload.queue, sourceId: payload.sourceId, message });
  } else {
    bridge().cancel?.(JSON.stringify({ id, message }));
  }
}

const pending = new Map<
  string,
  {
    cleanup: () => void;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timeoutId: number;
  }
>();

function installResolver(): void {
  if (typeof window === "undefined" || window.__noreaAndroidScraperResolve) {
    return;
  }

  window.__noreaAndroidScraperResolve = (id, payload) => {
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
  method: AndroidScraperMethod | "configureWorker" | "ensureWorker" | "closeWorker" | "showWorker",
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
        cancelNativeRequest(id, payload, "Android scraper request cancelled");
      } catch {
        // Best-effort native cleanup; the JS abort result is authoritative.
      }
      reject(requestAbortedError());
    };

    timeoutId = window.setTimeout(() => {
      pending.delete(id);
      try {
        cancelNativeRequest(id, payload, `Android scraper ${String(method)} timed out`);
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
      if (method === "configureWorker" || method === "ensureWorker" || method === "closeWorker" || method === "showWorker" ||
          (typeof payload.queue === "string" && payload.queue.startsWith("vpn:"))) {
        sendWorkerCommand(method, { id, ...payload });
      } else {
        bridge()[method as AndroidScraperMethod](JSON.stringify({ id, ...payload }));
      }
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
  if (executor.startsWith("vpn:")) {
    const sourceId = vpnWorkerSources.get(executor);
    if (!sourceId) return false;
    try {
      sendWorkerCommand("cancelBackground", { id: `android-scraper-${nextRequestId++}`, queue: executor, sourceId, message });
      return true;
    } catch {
      return false;
    }
  }
  const nativeBridge = window.__NoreaAndroidScraper;
  if (!nativeBridge?.cancelBackground) return false;
  nativeBridge.cancelBackground(JSON.stringify({ message, queue: executor }));
  return true;
}

export async function androidConfigureVpnDownloadWorker(
  worker: VpnDownloadWorkerRef,
  configuration: { sourceId: string; profileId: string; proxyPort: number },
): Promise<void> {
  const queue = vpnWorkerQueue(worker);
  if (!Number.isInteger(configuration.proxyPort) || configuration.proxyPort < 1 || configuration.proxyPort > 65_535) {
    throw new Error("Android VPN worker proxy port is invalid.");
  }
  if (!configuration.profileId.trim()) throw new Error("Android VPN worker profile identity is invalid.");
  await callNative("configureWorker", { ...configuration, slot: worker.slot, generation: worker.generation, queue }, 15_000);
  vpnWorkerSources.set(queue, configuration.sourceId);
}

export async function androidCloseVpnDownloadWorker(worker: VpnDownloadWorkerRef, sourceId: string): Promise<void> {
  const queue = vpnWorkerQueue(worker);
  try {
    await callNative("closeWorker", { queue, sourceId }, 15_000);
  } finally {
    vpnWorkerSources.delete(queue);
  }
}

export async function androidEnsureVpnDownloadWorker(
  worker: VpnDownloadWorkerRef,
  configuration: { sourceId: string; profileId: string; proxyPort: number },
): Promise<void> {
  await callNative("ensureWorker", { ...configuration, slot: worker.slot, generation: worker.generation, queue: vpnWorkerQueue(worker) }, 20_000);
}

export async function androidShowVpnDownloadWorker(worker: VpnDownloadWorkerRef, sourceId: string): Promise<void> {
  await callNative("showWorker", { queue: vpnWorkerQueue(worker), sourceId }, 15_000);
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

export function androidScraperCurrentOrigin(
  sourceId: string,
): Promise<string | null> {
  return callNative<string | null>("currentOrigin", { sourceId }, 5_000);
}

export function androidScraperCurrentUrl(sourceId: string): Promise<string | null> {
  return callNative<string | null>("currentUrl", { sourceId }, 5_000);
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
  priority?: string,
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
      ...(priority ? { priority } : {}),
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
  signal?: AbortSignal,
  chapterNavigationScript?: string,
): Promise<string> {
  return callNative<string>(
    "extract",
    {
      url,
      beforeScript,
      ...(chapterNavigationScript ? { chapterNavigationScript } : {}),
      timeoutMs,
      userAgent,
      ...(sourceId ? { sourceId } : {}),
      queue: executor,
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
      timeoutMs,
    },
    timeoutMs + 5_000,
    options.signal,
  );
}
