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
import { isAppActive, subscribeAppLifecycle } from "./app-lifecycle";
import { describeError } from "./errors";
import { isNetworkOnline, useNetworkStore } from "./network";
import { isAndroidRuntime } from "./tauri-runtime";
import { usePluginVpnStore } from "../store/plugin-vpn";

// Background work keeps the app WebView running, so a lost session is retried
// without waiting for the user to bring the app back to the foreground.
const RECOVERY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
// A dead server would otherwise be retried forever while download workers cannot lease it.
const FAILURES_BEFORE_PROFILE_SWITCH = 3;
// Data-path stalls occur after OpenVPN handshake succeeded, so switch away immediately
// and keep failed profiles excluded until a replacement stays healthy past this window.
const ZOMBIE_TUNNEL_ERROR = /stopped carrying traffic/i;
const FAILED_PROFILE_COOLDOWN_MS = 60_000;

type FailureOutcome = "retry" | "switched" | "stopped" | "superseded";

function byRecoveryPreference(left: SavedVpnProfile, right: SavedVpnProfile): number {
  return pluginVpnProfileSucceededAt(right.hash) - pluginVpnProfileSucceededAt(left.hash) ||
    right.approvalSequence - left.approvalSequence;
}

export interface PluginVpnRecoverySnapshot {
  failedAttempts: number;
  lastError: string | null;
}

const EMPTY_RECOVERY_SNAPSHOT: PluginVpnRecoverySnapshot = {
  failedAttempts: 0,
  lastError: null,
};

let recoverySnapshot: PluginVpnRecoverySnapshot = EMPTY_RECOVERY_SNAPSHOT;
const recoveryStateListeners = new Set<() => void>();

function publishRecoverySnapshot(next: PluginVpnRecoverySnapshot): void {
  if (
    recoverySnapshot.failedAttempts === next.failedAttempts &&
    recoverySnapshot.lastError === next.lastError
  ) {
    return;
  }
  recoverySnapshot = next;
  for (const listener of [...recoveryStateListeners]) listener();
}

export function getPluginVpnRecoverySnapshot(): PluginVpnRecoverySnapshot {
  return recoverySnapshot;
}

export function subscribePluginVpnRecovery(listener: () => void): () => void {
  recoveryStateListeners.add(listener);
  return () => {
    recoveryStateListeners.delete(listener);
  };
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
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingZombieProfile: { profile: PluginVpnProfile; error: string } | null = null;
  let stopStatusListener: (() => void) | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const clearStabilityTimer = () => {
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = null;
  };
  const resetEpisode = (preserveFailedProfiles = false) => {
    failedAttempts = 0;
    retryFailures = 0;
    failingProfile = null;
    profileFailures = 0;
    clearStabilityTimer();
    if (preserveFailedProfiles && failedProfileKeys.size > 0) {
      stabilityTimer = setTimeout(() => {
        stabilityTimer = null;
        failedProfileKeys = new Set();
      }, FAILED_PROFILE_COOLDOWN_MS);
    } else {
      failedProfileKeys = new Set();
    }
    publishRecoverySnapshot(EMPTY_RECOVERY_SNAPSHOT);
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
  const switchProfile = async (
    failed: PluginVpnProfile,
    allowSingleProfileRetry = false,
  ): Promise<FailureOutcome> => {
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
    if (allowSingleProfileRetry && vault.profiles.length <= 1) {
      if (failed.hash !== failingProfile) {
        failingProfile = failed.hash;
        profileFailures = 0;
      }
      profileFailures += 1;
      if (profileFailures < FAILURES_BEFORE_PROFILE_SWITCH) {
        failedProfileKeys.delete(failed.hash);
        failedProfileKeys.delete(failed.remoteHost);
        return "retry";
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
  const recoverZombieTunnel = (profile: PluginVpnProfile, errorMessage: string) => {
    if (!active || !isNetworkOnline() || isPluginVpnRecoveryStopped()) return;
    if (restoring) {
      pendingZombieProfile = { profile, error: errorMessage };
      return;
    }
    clearRetry();
    clearStabilityTimer();
    restoring = true;
    failedAttempts += 1;
    if (failedAttempts === 1) onError(new Error(errorMessage));
    void switchProfile(profile, true).catch((failure: unknown) => {
      console.warn("[plugin-vpn] zombie tunnel failover failed", failure);
      return "retry" as const;
    }).then((outcome) => {
      restoring = false;
      if (!active || !isNetworkOnline()) return;
      if (outcome === "switched" || outcome === "retry") restore();
      else if (outcome === "stopped") onStopped?.();
    });
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
          resetEpisode(failedProfileKeys.size > 0);
        } else {
          failedAttempts = 0;
          retryFailures = 0;
        }
        if (status) onRestored(status);
        if (pendingZombieProfile) {
          const next = pendingZombieProfile;
          pendingZombieProfile = null;
          recoverZombieTunnel(next.profile, next.error);
          return;
        }
        if (recoveryPending) {
          recoveryPending = false;
          requestRecovery();
        }
      },
      (error: unknown) => {
        recoveryPending = false;
        pendingZombieProfile = null;
        if (!active || !isNetworkOnline()) {
          restoring = false;
          return;
        }
        failedAttempts += 1;
        retryFailures += 1;
        publishRecoverySnapshot({
          failedAttempts,
          lastError: describeError(error),
        });
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
    if (isAppActive()) restore();
  };
  const unsubscribeLifecycle = subscribeAppLifecycle((appActive) => {
    if (appActive) restore();
  });
  window.addEventListener("focus", foreground);
  const separateResumedListener = !isAndroidRuntime();
  if (separateResumedListener) {
    window.addEventListener("norea-app-resumed", restore);
  }
  void startPluginVpnStatusListener((event) => {
    if (event.kind === "reconnected" && event.status.phase === "connected") {
      resetEpisode();
    } else if (event.kind === "networkChanged" && isNetworkOnline()) {
      if (restoring) recoveryPending = true;
      else requestRecovery();
    } else if (event.kind === "error") {
      if (event.status.error) {
        publishRecoverySnapshot({
          failedAttempts: Math.max(recoverySnapshot.failedAttempts, 1),
          lastError: event.status.error,
        });
      }
      if (
        event.status.error &&
        ZOMBIE_TUNNEL_ERROR.test(event.status.error) &&
        event.status.profile
      ) {
        recoverZombieTunnel(event.status.profile, event.status.error);
      } else if (isRetryablePluginVpnError(event.status.error)) {
        requestRecovery();
      }
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
    clearStabilityTimer();
    pendingZombieProfile = null;
    stopStatusListener?.();
    stopNetworkListener();
    stopIntentListener();
    unsubscribeLifecycle();
    window.removeEventListener("focus", foreground);
    if (separateResumedListener) {
      window.removeEventListener("norea-app-resumed", restore);
    }
    recoveryRequests.delete(requestRecovery);
    publishRecoverySnapshot(EMPTY_RECOVERY_SNAPSHOT);
  };
}
