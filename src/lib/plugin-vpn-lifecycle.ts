import {
  restorePluginVpnConnection,
  startPluginVpnStatusListener,
  type PluginVpnStatus,
} from "./plugin-vpn";

// Background work keeps the app WebView running, so a lost session is retried
// without waiting for the user to bring the app back to the foreground.
const RECOVERY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

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
  let failedAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopStatusListener: (() => void) | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const scheduleRetry = () => {
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
    if (!active || restoring) return;
    clearRetry();
    restoring = true;
    void restorePluginVpnConnection().then(
      (status) => {
        restoring = false;
        if (!active) return;
        failedAttempts = 0;
        if (status) onRestored(status);
      },
      (error: unknown) => {
        restoring = false;
        if (!active) return;
        failedAttempts += 1;
        if (failedAttempts === 1) onError(error);
        scheduleRetry();
      },
    );
  };
  const foreground = () => {
    if (document.visibilityState !== "hidden") restore();
  };
  document.addEventListener("visibilitychange", foreground);
  window.addEventListener("focus", foreground);
  window.addEventListener("norea-app-resumed", restore);
  void startPluginVpnStatusListener((event) => {
    if (event.kind === "error") restore();
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
    document.removeEventListener("visibilitychange", foreground);
    window.removeEventListener("focus", foreground);
    window.removeEventListener("norea-app-resumed", restore);
  };
}
