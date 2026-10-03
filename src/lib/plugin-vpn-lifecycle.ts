import {
  restorePluginVpnConnection,
  isRetryablePluginVpnError,
  startPluginVpnStatusListener,
  type PluginVpnStatus,
} from "./plugin-vpn";
import { isNetworkOnline, useNetworkStore } from "./network";
import { usePluginVpnStore } from "../store/plugin-vpn";

// Background work keeps the app WebView running, so a lost session is retried
// without waiting for the user to bring the app back to the foreground.
const RECOVERY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

const recoveryRequests = new Set<() => void>();

// Network work can resume before a foreground event or after a missed native event.
export function requestPluginVpnRecovery(): void {
  for (const request of recoveryRequests) request();
}

interface PluginVpnLifecycleCallbacks {
  onRestored: (status: PluginVpnStatus) => void;
  onError: (error: unknown) => void;
}

export function startPluginVpnLifecycle({
  onRestored,
  onError,
}: PluginVpnLifecycleCallbacks): () => void {
  let active = true;
  let restoring = false;
  let recoveryPending = false;
  let failedAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopStatusListener: (() => void) | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const scheduleRetry = () => {
    if (!active || !isNetworkOnline()) return;
    const delayIndex = Math.min(
      failedAttempts - 1,
      RECOVERY_RETRY_DELAYS_MS.length - 1,
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      restore();
    }, RECOVERY_RETRY_DELAYS_MS[delayIndex]);
  };
  const restore = () => {
    if (!active || restoring || !isNetworkOnline() || retryTimer !== null) return;
    clearRetry();
    restoring = true;
    void restorePluginVpnConnection().then(
      (status) => {
        restoring = false;
        if (!active || !isNetworkOnline()) return;
        failedAttempts = 0;
        if (status) onRestored(status);
        if (recoveryPending) {
          recoveryPending = false;
          requestRecovery();
        }
      },
      (error: unknown) => {
        restoring = false;
        recoveryPending = false;
        if (!active || !isNetworkOnline()) return;
        failedAttempts += 1;
        if (failedAttempts === 1) onError(error);
        if (isRetryablePluginVpnError(error)) scheduleRetry();
      },
    );
  };
  const requestRecovery = () => {
    // Concurrent image requests must not bypass the shared recovery backoff.
    if (retryTimer === null) restore();
  };
  recoveryRequests.add(requestRecovery);
  const stopNetworkListener = useNetworkStore.subscribe((status, previous) => {
    if (status.connectivity !== "online") {
      clearRetry();
      failedAttempts = 0;
      recoveryPending = false;
    } else if (status.revision !== previous.revision || previous.connectivity !== "online") {
      if (restoring) recoveryPending = true;
      else requestRecovery();
    }
  });
  const stopIntentListener = usePluginVpnStore.subscribe((state) => {
    if (!state.enabled) {
      clearRetry();
      failedAttempts = 0;
      recoveryPending = false;
    }
  });
  const foreground = () => {
    if (document.visibilityState !== "hidden") restore();
  };
  document.addEventListener("visibilitychange", foreground);
  window.addEventListener("focus", foreground);
  window.addEventListener("norea-app-resumed", restore);
  void startPluginVpnStatusListener((event) => {
    if (event.kind === "networkChanged" && isNetworkOnline()) {
      if (restoring) recoveryPending = true;
      else requestRecovery();
    } else if (event.kind === "error" && isRetryablePluginVpnError(event.status.error)) {
      requestRecovery();
    }
  }).then(
    (unlisten) => {
      if (active) {
        stopStatusListener = unlisten;
      } else {
        unlisten();
      }
    },
    (error: unknown) => {
      console.warn("[plugin-vpn] failed to watch for lost connections", error);
    },
  );
  restore();
  return () => {
    active = false;
    clearRetry();
    stopStatusListener?.();
    stopNetworkListener();
    stopIntentListener();
    document.removeEventListener("visibilitychange", foreground);
    window.removeEventListener("focus", foreground);
    window.removeEventListener("norea-app-resumed", restore);
    recoveryRequests.delete(requestRecovery);
  };
}
