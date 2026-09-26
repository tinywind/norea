import { usePluginVpnStore } from "../store/plugin-vpn";
import { requestAbortedError } from "./abort";
import { getPluginVpnStatus } from "./plugin-vpn";
import { requestPluginVpnRecovery } from "./plugin-vpn-lifecycle";

export const PLUGIN_VPN_READY_TIMEOUT_MS = 120_000;
const PLUGIN_VPN_STATUS_POLL_MS = 500;

export class PluginVpnUnavailableError extends Error {
  readonly code = "plugin-vpn-unavailable" as const;

  constructor(readonly retryable = true) {
    super("Plugin VPN is unavailable. Reconnect the VPN and retry the download.");
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
): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(requestAbortedError());
  if (!usePluginVpnStore.getState().enabled) return Promise.resolve(false);

  return new Promise<boolean>((resolve, reject) => {
    let active = true;
    let waited = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      active = false;
      clearTimeout(timeoutTimer);
      clearTimeout(pollTimer);
      signal?.removeEventListener("abort", abort);
      unsubscribe?.();
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
