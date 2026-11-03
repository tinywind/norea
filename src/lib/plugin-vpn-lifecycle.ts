import {
  getPluginVpnStatus,
  isPluginVpnRecoveryStopped,
  pluginVpnProfileSucceededAt,
  releasePluginVpnRecoveryProfile,
  replacePluginVpnRecoveryProfile,
  restorePluginVpnConnection,
  resumePluginVpnRecovery,
  isRetryablePluginVpnError,
  startPluginVpnStatusListener,
  type PluginVpnProfile,
  type PluginVpnStatus,
} from "./plugin-vpn";
import { listSavedPluginVpnProfiles, type SavedVpnProfile } from "./plugin-vpn-profiles";
import { isNetworkOnline, useNetworkStore } from "./network";
import { usePluginVpnStore } from "../store/plugin-vpn";

// Background work keeps the app WebView running, so a lost session is retried
// without waiting for the user to bring the app back to the foreground.
const RECOVERY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
// A dead server would otherwise be retried forever while download workers cannot lease it.
const FAILURES_BEFORE_PROFILE_SWITCH = 3;

type FailureOutcome = "retry" | "switched" | "stopped" | "superseded";

function byRecoveryPreference(left: SavedVpnProfile, right: SavedVpnProfile): number {
  return pluginVpnProfileSucceededAt(right.hash) - pluginVpnProfileSucceededAt(left.hash) ||
    right.approvalSequence - left.approvalSequence;
}

const recoveryRequests = new Set<() => void>();

// Network work can resume before a foreground event or after a missed native event.
export function requestPluginVpnRecovery(): void {
  for (const request of recoveryRequests) request();
}

interface PluginVpnLifecycleCallbacks {
  onRestored: (status: PluginVpnStatus) => void;
  onError: (error: unknown) => void;
  /** Called once when no other retained profile can replace a profile that keeps failing. */
  onStopped?: () => void;
}

export function startPluginVpnLifecycle({
  onRestored,
  onError,
  onStopped,
}: PluginVpnLifecycleCallbacks): () => void {
  let active = true;
  let restoring = false;
  let recoveryPending = false;
  let failedAttempts = 0;
  let retryFailures = 0;
  let failingProfile: string | null = null;
  let profileFailures = 0;
  let failedProfileKeys = new Set<string>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopStatusListener: (() => void) | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const resetEpisode = () => {
    failedAttempts = 0;
    retryFailures = 0;
    failingProfile = null;
    profileFailures = 0;
    failedProfileKeys = new Set();
  };
  const scheduleRetry = () => {
    if (!active || !isNetworkOnline()) return;
    const delayIndex = Math.min(
      retryFailures - 1,
      RECOVERY_RETRY_DELAYS_MS.length - 1,
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      restore();
    }, RECOVERY_RETRY_DELAYS_MS[delayIndex]);
  };
  const switchProfile = async (failed: PluginVpnProfile): Promise<FailureOutcome> => {
    failedProfileKeys.add(failed.hash);
    failedProfileKeys.add(failed.remoteHost);
    const vault = await listSavedPluginVpnProfiles();
    const candidates = vault.profiles
      .filter(profile => !failedProfileKeys.has(profile.hash) && !failedProfileKeys.has(profile.ip))
      .sort(byRecoveryPreference);
    for (const candidate of candidates) {
      try {
        if (!await replacePluginVpnRecoveryProfile(candidate)) return "superseded";
        failingProfile = candidate.hash;
        profileFailures = 0;
        retryFailures = 0;
        return "switched";
      } catch (error) {
        // Native refuses a profile a download worker leases; the next candidate may be idle.
        console.warn("[plugin-vpn] recovery profile replacement skipped", error);
      }
    }
    return await releasePluginVpnRecoveryProfile() ? "stopped" : "superseded";
  };
  const handleFailure = async (): Promise<FailureOutcome> => {
    let profile: PluginVpnStatus["profile"];
    try {
      profile = (await getPluginVpnStatus()).profile;
    } catch {
      return "retry";
    }
    if (!profile) return "retry";
    if (profile.hash !== failingProfile) {
      failingProfile = profile.hash;
      profileFailures = 0;
    }
    profileFailures += 1;
    if (profileFailures < FAILURES_BEFORE_PROFILE_SWITCH) return "retry";
    return switchProfile(profile);
  };
  const restore = () => {
    if (!active || restoring || !isNetworkOnline() || retryTimer !== null || isPluginVpnRecoveryStopped()) return;
    clearRetry();
    restoring = true;
    void restorePluginVpnConnection().then(
      (status) => {
        restoring = false;
        if (!active || !isNetworkOnline()) return;
        if (status) {
          resetEpisode();
        } else {
          failedAttempts = 0;
          retryFailures = 0;
        }
        if (status) onRestored(status);
        if (recoveryPending) {
          recoveryPending = false;
          requestRecovery();
        }
      },
      (error: unknown) => {
        recoveryPending = false;
        if (!active || !isNetworkOnline()) {
          restoring = false;
          return;
        }
        failedAttempts += 1;
        retryFailures += 1;
        if (failedAttempts === 1) onError(error);
        if (!isRetryablePluginVpnError(error)) {
          restoring = false;
          return;
        }
        void handleFailure().catch((failure: unknown) => {
          console.warn("[plugin-vpn] recovery profile switch failed", failure);
          return "retry" as const;
        }).then((outcome) => {
          restoring = false;
          if (!active || !isNetworkOnline()) return;
          if (outcome === "retry") scheduleRetry();
          else if (outcome === "switched") restore();
          else if (outcome === "stopped") onStopped?.();
        });
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
      resetEpisode();
      recoveryPending = false;
    } else if (status.revision !== previous.revision || previous.connectivity !== "online") {
      // A different route is new evidence that the released profiles may connect again.
      if (isPluginVpnRecoveryStopped()) {
        resumePluginVpnRecovery();
        resetEpisode();
      }
      if (restoring) recoveryPending = true;
      else requestRecovery();
    }
  });
  const stopIntentListener = usePluginVpnStore.subscribe((state) => {
    if (!state.enabled) {
      clearRetry();
      resetEpisode();
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
