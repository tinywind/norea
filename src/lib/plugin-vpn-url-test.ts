import { invoke } from "@tauri-apps/api/core";
import { usePluginVpnUrlTestStore } from "../store/plugin-vpn-url-test";
import { useUserAgentStore } from "../store/user-agent";
import { describeError } from "./errors";

/** The profile a URL test connects with, identified as each list shows it. */
export type PluginVpnUrlTestProfile =
  | { kind: "finder"; candidateId: string }
  | { kind: "saved"; id: string; expectedHash: string }
  | { kind: "manual"; host: string; expectedHash: string };

export type PluginVpnUrlTestResult =
  | { kind: "ok"; status: number; elapsedMs: number }
  | { kind: "httpError"; status: number; elapsedMs: number }
  | { kind: "cloudflareChallenge"; status: number; elapsedMs: number }
  | { kind: "connectionFailed"; reason: string }
  | { kind: "requestFailed"; reason: string }
  | { kind: "timedOut"; stage: "connect" | "request" }
  | { kind: "credentialsRequired" }
  | { kind: "inUse" }
  | { kind: "cancelled" };

/** A test result, or why the test could not start, such as a profile that is gone. */
export type PluginVpnUrlTestOutcome =
  | Exclude<PluginVpnUrlTestResult, { kind: "cancelled" }>
  | { kind: "error"; message: string };

export interface PluginVpnUrlTestTarget {
  host: string;
  profile: PluginVpnUrlTestProfile;
}

const MAX_TEST_URL_LENGTH = 2048;

/** The trimmed URL when it is an absolute http or https address with a host; null otherwise. */
export function parsePluginVpnTestUrl(input: string): string | null {
  const value = input.trim();
  if (!value || value.length > MAX_TEST_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  return value;
}

function testPluginVpnProfileUrl(
  runId: string,
  profile: PluginVpnUrlTestProfile,
  url: string,
): Promise<PluginVpnUrlTestResult> {
  return invoke("plugin_vpn_test_profile_url", {
    runId,
    profile,
    url,
    userAgent: useUserAgentStore.getState().userAgent,
  });
}

/**
 * Tests each target in turn: one separate test tunnel and one GET per host,
 * never two at once and never retried. Duplicate hosts are tested once. A
 * run already in progress makes this a no-op that returns false.
 */
export async function runPluginVpnUrlTests(
  targets: readonly PluginVpnUrlTestTarget[],
  input: string,
): Promise<boolean> {
  const url = parsePluginVpnTestUrl(input);
  const store = usePluginVpnUrlTestStore;
  if (url === null || store.getState().run !== null) return false;
  const unique = [...new Map(targets.map((target) => [target.host, target])).values()];
  if (unique.length === 0) return false;
  const runId = `vpn-url-test-${crypto.randomUUID()}`;
  store.setState({
    run: { id: runId, hosts: unique.map((target) => target.host), cancelling: false },
    progress: Object.fromEntries(unique.map((target) => [target.host, "queued" as const])),
  });
  try {
    for (const target of unique) {
      if (store.getState().run?.cancelling !== false) break;
      store.setState((state) => ({ progress: { ...state.progress, [target.host]: "testing" } }));
      let outcome: PluginVpnUrlTestOutcome;
      try {
        const result = await testPluginVpnProfileUrl(runId, target.profile, url);
        if (result.kind === "cancelled") break;
        outcome = result;
      } catch (error) {
        outcome = { kind: "error", message: describeError(error) };
      }
      store.setState((state) => {
        const progress = { ...state.progress };
        delete progress[target.host];
        return { progress, results: { ...state.results, [target.host]: { outcome, url } } };
      });
    }
  } finally {
    store.setState({ run: null, progress: {} });
  }
  return true;
}

/** Stops the running test and skips the rest of its run. */
export async function cancelPluginVpnUrlTests(): Promise<void> {
  const run = usePluginVpnUrlTestStore.getState().run;
  if (!run || run.cancelling) return;
  usePluginVpnUrlTestStore.setState({ run: { ...run, cancelling: true } });
  await invoke("plugin_vpn_cancel_url_test", { runId: run.id });
}
