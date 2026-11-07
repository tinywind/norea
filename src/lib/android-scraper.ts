import { requestAbortedError } from "./abort";
import { getDownloadRecoveryPolicy } from "../store/download-recovery";
import { isAndroidRuntime } from "./tauri-runtime";
import type { ScraperExecutorId } from "./tasks/scraper-queue";
import { androidBridgeAuthority } from "./android-bridge";
import type { VpnDownloadWorkerRef } from "./tasks/vpn-download-types";
import { isVpnDownloadWorkerSlot } from "./tasks/vpn-download-types";
import { withPluginVpnTransportDiagnostics } from "./plugin-vpn-transport";

interface AndroidVpnDownloadWorkerBridge {
  capabilities: () => string;
  request: (payload: string) => void;
}

interface AndroidScraperBridge {
  cancel?(payload: string): void;
  cancelBackground?(payload: string): void;
  clearCache(payload: string): void;
  clearCookies(payload: string): void;
  resetVpnSession(payload: string): void;
  resetSiteData?(payload: string): void;
  canResetSiteData?(): boolean;
  canRotateFingerprint?(): boolean;
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
const vpnWorkers = new Map<string, { sourceId: string; worker: VpnDownloadWorkerRef }>();
type AndroidScraperMethod = "clearCache" | "clearCookies" | "resetVpnSession" | "resetSiteData" | "currentOrigin" | "currentUrl" | "extract" | "fetch" | "navigate";
type AndroidWorkerMethod = AndroidScraperMethod | "configureWorker" | "ensureWorker" | "closeWorker" | "showWorker" | "cancel" | "cancelBackground";

interface SiteDispatch {
  queue?: string;
  start: () => void;
  cancel: () => void;
}
let siteDispatchActive = false;
let siteDispatchBlocked: Error | null = null;
const siteDispatches: SiteDispatch[] = [];

/** One native site operation at a time, including its transport diagnostic window. */
function withSiteDispatch<T>(run: () => Promise<T>, signal?: AbortSignal, queue?: string): Promise<T> {
  if (signal?.aborted) return Promise.reject(requestAbortedError());
  return new Promise<T>((resolve, reject) => {
    let started = false;
    const entry: SiteDispatch = {
      queue,
      cancel: () => {
        if (started) return;
        const index = siteDispatches.indexOf(entry);
        if (index >= 0) siteDispatches.splice(index, 1);
        signal?.removeEventListener("abort", entry.cancel);
        reject(requestAbortedError());
      },
      start: () => {
        started = true;
        signal?.removeEventListener("abort", entry.cancel);
        siteDispatchActive = true;
        let result: Promise<T>;
        try {
          if (siteDispatchBlocked) throw siteDispatchBlocked;
          if (signal?.aborted) throw requestAbortedError();
          result = run();
        } catch (error) {
          result = Promise.reject(error);
        }
        const finish = () => {
          siteDispatchActive = false;
          siteDispatches.shift()?.start();
        };
        void result.then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
      },
    };
    signal?.addEventListener("abort", entry.cancel, { once: true });
    if (siteDispatchActive) siteDispatches.push(entry);
    else entry.start();
  });
}

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
    let cleanupTimeoutId = 0;
    let cancellation: Error | null = null;
    let abortListener: (() => void) | undefined;
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      window.clearTimeout(cleanupTimeoutId);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    };
    const cancelAndWait = (error: Error) => {
      if (cancellation) return;
      cancellation = error;
      window.clearTimeout(timeoutId);
      // Keep the dispatch lease until native cancellation acknowledges cleanup.
      // A missing acknowledgement blocks later site requests until a route reset.
      cleanupTimeoutId = window.setTimeout(() => {
        pending.delete(id);
        cleanup();
        siteDispatchBlocked = new Error("The previous site browser request did not finish cancelling. Reset the VPN browser session before continuing.");
        reject(error);
      }, 35_000);
      try {
        cancelNativeRequest(id, payload, error.message);
      } catch {
        pending.delete(id);
        cleanup();
        siteDispatchBlocked = new Error("The previous site browser request could not be cancelled. Reset the VPN browser session before continuing.");
        reject(error);
      }
    };
    abortListener = () => cancelAndWait(requestAbortedError());
    timeoutId = window.setTimeout(() => {
      cancelAndWait(new Error(`Android scraper ${String(method)} timed out`));
    }, timeoutMs);

    pending.set(id, {
      cleanup,
      resolve: (value) => cancellation ? reject(cancellation) : resolve(value as T),
      reject: (error) => reject(cancellation ?? error),
      timeoutId,
    });
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) {
      pending.delete(id);
      cleanup();
      reject(requestAbortedError());
      return;
    }

    try {
      if (method === "configureWorker" || method === "ensureWorker" || method === "closeWorker" || method === "showWorker" ||
          (typeof payload.queue === "string" && payload.queue.startsWith("vpn:"))) {
        sendWorkerCommand(method, { id, ...payload });
      } else {
        const nativeBridge = bridge();
        const dispatch = nativeBridge[method as AndroidScraperMethod];
        if (!dispatch) throw new Error(`Android scraper ${method} is unavailable.`);
        dispatch.call(nativeBridge, JSON.stringify({ id, ...payload }));
      }
    } catch (error) {
      pending.delete(id);
      cleanup();
      reject(error);
    }
  });
}

function callNetworkNative<T>(
  method: "fetch" | "extract" | "navigate",
  payload: Record<string, unknown> & { url: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return withSiteDispatch(() => {
    const run = () => callNative<T>(method, payload, timeoutMs, signal);
    const queue = typeof payload.queue === "string" ? payload.queue : "immediate";
    const worker = vpnWorkers.get(queue)?.worker ?? null;
    if (queue.startsWith("vpn:") && !worker) return run();
    return withPluginVpnTransportDiagnostics(payload.url, worker, run, signal);
  }, signal, typeof payload.queue === "string" ? payload.queue : "immediate");
}

export function cancelAndroidScraperExecutor(
  message: string,
  executor: ScraperExecutorId,
): boolean {
  if (!isAndroidRuntime() || typeof window === "undefined") return false;
  for (const entry of [...siteDispatches]) if (entry.queue === executor) entry.cancel();
  if (executor.startsWith("vpn:")) {
    const sourceId = vpnWorkers.get(executor)?.sourceId;
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
  configuration: { sourceId: string; profileId: string; profileHash: string; proxyPort: number },
): Promise<void> {
  const queue = vpnWorkerQueue(worker);
  if (!Number.isInteger(configuration.proxyPort) || configuration.proxyPort < 1 || configuration.proxyPort > 65_535) {
    throw new Error("Android VPN worker proxy port is invalid.");
  }
  if (!configuration.profileId.trim()) throw new Error("Android VPN worker profile identity is invalid.");
  if (!/^[a-f0-9]{64}$/.test(configuration.profileHash)) throw new Error("Android VPN worker profile hash is invalid.");
  await callNative("configureWorker", { ...configuration, slot: worker.slot, generation: worker.generation, queue,
    rotateFingerprintOnVpnChange: getDownloadRecoveryPolicy().rotateFingerprintOnVpnChange }, 70_000);
  vpnWorkers.set(queue, { sourceId: configuration.sourceId, worker: { ...worker } });
}

export async function androidCloseVpnDownloadWorker(worker: VpnDownloadWorkerRef, sourceId: string): Promise<void> {
  const queue = vpnWorkerQueue(worker);
  try {
    await callNative("closeWorker", { queue, sourceId }, 70_000);
  } finally {
    vpnWorkers.delete(queue);
  }
}

export async function androidEnsureVpnDownloadWorker(
  worker: VpnDownloadWorkerRef,
  configuration: { sourceId: string; profileId: string; profileHash: string; proxyPort: number },
): Promise<void> {
  const queue = vpnWorkerQueue(worker);
  await callNative("ensureWorker", { ...configuration, slot: worker.slot, generation: worker.generation, queue,
    rotateFingerprintOnVpnChange: getDownloadRecoveryPolicy().rotateFingerprintOnVpnChange }, 70_000);
  vpnWorkers.set(queue, { sourceId: configuration.sourceId, worker: { ...worker } });
}

export async function androidScraperResetVpnSession(): Promise<void> {
  for (const entry of [...siteDispatches]) entry.cancel();
  await callNative("resetVpnSession", {}, 35_000);
  siteDispatchBlocked = null;
}

export async function androidScraperResetSiteData(url: string, sourceId?: string): Promise<void> {
  if (bridge().canResetSiteData?.() !== true) throw new Error("Resetting site data requires an updated Android System WebView.");
  await withSiteDispatch(() => callNative("resetSiteData", { url, ...(sourceId ? { sourceId } : {}) }, 70_000));
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
  return callNetworkNative<AndroidFetchResultWire>(
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
    timeoutMs + 35_000,
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
  return callNetworkNative<string>(
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
    timeoutMs + 35_000,
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
    forceNavigation?: boolean;
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return callNetworkNative<boolean>(
    "navigate",
    {
      url,
      sourceId,
      userAgent,
      timeoutMs,
      forceNavigation: options.forceNavigation ?? false,
    },
    timeoutMs + 35_000,
    options.signal,
  );
}
