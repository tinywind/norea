import { usePluginVpnStore } from "../store/plugin-vpn";
import { requestAbortedError } from "./abort";
import { requireNetworkOnline, isNetworkOnline, NetworkUnavailableError, useNetworkStore } from "./network";
import { getPluginVpnStatus, isPluginVpnRecoveryStopped, isRetryablePluginVpnError } from "./plugin-vpn";
import { requestPluginVpnRecovery } from "./plugin-vpn-lifecycle";
import type { ScraperExecutorId } from "./tasks/scraper-queue";
import { getVpnDownloadWorkerContext } from "./tasks/vpn-worker-context";
import { getPluginVpnDownloadWorkerStatus } from "./plugin-vpn-download-workers";
import { isAndroidRuntime } from "./tauri-runtime";

export const PLUGIN_VPN_READY_TIMEOUT_MS = 120_000;
const PLUGIN_VPN_STATUS_POLL_MS = 500;

export class PluginVpnUnavailableError extends Error {
  readonly code = "plugin-vpn-unavailable" as const;

  constructor(readonly retryable = true, detail?: string) {
    super(detail ? `Plugin VPN is unavailable: ${detail}` : "Plugin VPN is unavailable. Reconnect the VPN and retry the download.");
    this.name = "PluginVpnUnavailableError";
  }
}

export function isPluginVpnUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "plugin-vpn-unavailable"
  );
}

/** Wait for the selected VPN, never substituting a direct network request. */
export function waitForPluginVpnReady(
  signal?: AbortSignal,
  deadline = Date.now() + PLUGIN_VPN_READY_TIMEOUT_MS,
  executor?: ScraperExecutorId,
): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(requestAbortedError());
  try { requireNetworkOnline(); } catch (error) { return Promise.reject(error); }
  if (executor?.startsWith("vpn:") && isAndroidRuntime()) return waitForDownloadWorkerReady(executor, signal, deadline);
  if (!usePluginVpnStore.getState().enabled) return Promise.resolve(false);
  if (isPluginVpnRecoveryStopped()) return Promise.reject(new PluginVpnUnavailableError(false));

  return new Promise<boolean>((resolve, reject) => {
    let active = true;
    let waited = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeNetwork: (() => void) | undefined;
    const cleanup = () => {
      active = false;
      clearTimeout(timeoutTimer);
      clearTimeout(pollTimer);
      signal?.removeEventListener("abort", abort);
      unsubscribe?.();
      unsubscribeNetwork?.();
    };
    const finish = () => {
      if (!active) return;
      cleanup();
      resolve(waited);
    };
    const fail = (error: unknown) => {
      if (!active) return;
      cleanup();
      reject(error);
    };
    const abort = () => fail(requestAbortedError());
    const timeoutTimer = setTimeout(
      () => fail(new PluginVpnUnavailableError()),
      Math.max(0, deadline - Date.now()),
    );
    unsubscribe = usePluginVpnStore.subscribe((state) => {
      if (!state.enabled) finish();
    });
    unsubscribeNetwork = useNetworkStore.subscribe(() => {
      if (!isNetworkOnline()) fail(new NetworkUnavailableError());
    });
    signal?.addEventListener("abort", abort, { once: true });

    const poll = async () => {
      try {
        const status = await getPluginVpnStatus();
        if (!active) return;
        if (!usePluginVpnStore.getState().enabled) {
          finish();
          return;
        }
        if (status.supported && status.phase === "connected") {
          finish();
          return;
        }
        if (!status.supported || !status.profile) {
          fail(new PluginVpnUnavailableError(false));
          return;
        }
        if (status.error && !isRetryablePluginVpnError(status.error)) {
          fail(new PluginVpnUnavailableError(false));
          return;
        }
        if (Date.now() >= deadline) {
          fail(new PluginVpnUnavailableError());
          return;
        }
        waited = true;
        requestPluginVpnRecovery();
        if (active) pollTimer = setTimeout(() => void poll(), PLUGIN_VPN_STATUS_POLL_MS);
      } catch {
        // An unavailable status bridge cannot establish a safe network route.
        fail(new PluginVpnUnavailableError());
      }
    };
    if (signal?.aborted) abort();
    else void poll();
  });
}

async function waitForDownloadWorkerReady(executor: ScraperExecutorId, signal: AbortSignal | undefined, deadline: number): Promise<boolean> {
  let waited = false;
  for (;;) {
    if (signal?.aborted) throw requestAbortedError();
    requireNetworkOnline();
    const worker = getVpnDownloadWorkerContext(executor);
    if (!worker) throw new PluginVpnUnavailableError(false, "VPN worker session is no longer active.");
    const status = await getPluginVpnDownloadWorkerStatus(worker).catch((error: unknown) => {
      throw new PluginVpnUnavailableError(false, error instanceof Error ? error.message : String(error));
    });
    if (signal?.aborted) throw requestAbortedError();
    if (getVpnDownloadWorkerContext(executor) !== worker || !status.supported ||
        status.worker?.rangeId !== worker.rangeId || status.worker.slot !== worker.slot || status.worker.generation !== worker.generation) {
      throw new PluginVpnUnavailableError(false, "VPN worker identity changed.");
    }
    if (status.phase === "connected") return waited;
    if ((status.phase !== "connecting" && status.phase !== "reconnecting") || Date.now() >= deadline) {
      throw new PluginVpnUnavailableError(false, status.error ?? "The VPN worker connection is unavailable.");
    }
    waited = true;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(requestAbortedError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, Math.max(0, Math.min(PLUGIN_VPN_STATUS_POLL_MS, deadline - Date.now())));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}
