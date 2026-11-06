import { invoke } from "@tauri-apps/api/core";
import { runExclusiveDatabaseOperation } from "../db/client";
import type { PluginVpnServerProtocol } from "./plugin-vpn";
import { syncStoredPluginVpnProfiles, type SavedVpnProfile } from "./plugin-vpn-profiles";

export const AUTOMATIC_PLUGIN_VPN_PROFILES_QUERY_KEY = ["plugin-vpn", "automatic-profiles"] as const;

/** A VPN Gate server that passed an automatic test. It never carries or changes an O/X verdict. */
export interface AutomaticVpnProfile {
  id: string;
  ip: string;
  protocol: PluginVpnServerProtocol;
  hash: string;
  score: number;
  testedAt: number;
  failures: number;
}

export function listAutomaticPluginVpnProfiles(): Promise<AutomaticVpnProfile[]> {
  return invoke("plugin_vpn_list_automatic_profiles");
}

const automaticCandidateTests = new Map<AbortController, Promise<boolean>>();

function candidateTestAbortError(): DOMException {
  return new DOMException("Automatic VPN candidate test was cancelled.", "AbortError");
}

/** Test-connects one cached candidate and waits for native cleanup when cancelled. */
export function testAutomaticPluginVpnCandidate(candidateId: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(candidateTestAbortError());
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const result = runAutomaticCandidateTest(candidateId, controller.signal).finally(() => {
    signal?.removeEventListener("abort", abort);
    automaticCandidateTests.delete(controller);
  });
  automaticCandidateTests.set(controller, result);
  return result;
}

/** Cancels all active automatic probes and waits until each native tunnel has stopped. */
export async function cancelAutomaticPluginVpnCandidateTests(): Promise<void> {
  const active = [...automaticCandidateTests];
  for (const [controller] of active) controller.abort();
  const results = await Promise.allSettled(active.map(([, result]) => result));
  for (const result of results) {
    if (result.status === "rejected" && !(result.reason instanceof DOMException && result.reason.name === "AbortError")) {
      throw result.reason;
    }
  }
}

async function runAutomaticCandidateTest(candidateId: string, signal: AbortSignal): Promise<boolean> {
  const probeId = crypto.randomUUID();
  await invoke("plugin_vpn_prepare_automatic_candidate_test", { probeId });
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= invoke<void>("plugin_vpn_cancel_automatic_candidate_test", { probeId });
    void cancellation.catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) {
      cancel();
      throw candidateTestAbortError();
    }
    const result = await invoke<boolean>("plugin_vpn_test_automatic_candidate", { candidateId, probeId });
    if (signal.aborted) throw candidateTestAbortError();
    return result;
  } catch (error) {
    if (signal.aborted) throw candidateTestAbortError();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    await cancellation;
  }
}

export function recordAutomaticPluginVpnProfileResult(profile: Pick<AutomaticVpnProfile, "id" | "hash">, connected: boolean): Promise<void> {
  return invoke("plugin_vpn_record_automatic_profile_result", { id: profile.id, expectedHash: profile.hash, connected });
}

/**
 * "Approve all working": saves every tested server without a recent tunnel
 * failure as an O-approved profile and returns the newly approved ones. It
 * is the user's explicit verdict; the app never approves servers by itself.
 */
export async function approveWorkingAutomaticPluginVpnProfiles(): Promise<SavedVpnProfile[]> {
  const approved = await runExclusiveDatabaseOperation<SavedVpnProfile[]>(
    () => invoke("plugin_vpn_approve_working_automatic_profiles"),
    { publishMetadata: false },
  );
  void syncStoredPluginVpnProfiles();
  return approved;
}
