import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { requestAbortedError } from "./abort";
import { isTauriRuntime } from "./tauri-runtime";

export interface NetworkStatus {
  connectivity: "unknown" | "offline" | "limited" | "online";
  revision: number;
}

export const useNetworkStore = create<NetworkStatus>(() => ({
  connectivity: "online",
  revision: -1,
}));

export class NetworkUnavailableError extends Error {
  readonly code = "network-unavailable";

  constructor() {
    super("Internet access is unavailable. Waiting for the network.");
    this.name = "NetworkUnavailableError";
  }
}

export function isNetworkUnavailableError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "network-unavailable";
}

export function isNetworkOnline(): boolean {
  return useNetworkStore.getState().connectivity === "online";
}

export function requireNetworkOnline(): void {
  if (!isNetworkOnline()) throw new NetworkUnavailableError();
}

/** Cancel network work when its system route disappears or changes. */
export async function withNetworkRequest<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw requestAbortedError();
  requireNetworkOnline();
  const revision = useNetworkStore.getState().revision;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  const unsubscribe = useNetworkStore.subscribe((status) => {
    if (status.connectivity !== "online" || status.revision !== revision) {
      controller.abort(new NetworkUnavailableError());
    }
  });
  try {
    const result = await run(controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } catch (error) {
    if (signal?.aborted) throw requestAbortedError();
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", cancel);
  }
}

export async function initializeNetworkStatus(): Promise<void> {
  if (!isTauriRuntime()) return;
  useNetworkStore.setState({ connectivity: "unknown" });
  const update = (status: NetworkStatus) => {
    if (status.revision >= useNetworkStore.getState().revision) {
      useNetworkStore.setState(status);
    }
  };
  try {
    // Listen before reading so an older startup snapshot cannot overwrite an event.
    await listen<NetworkStatus>("network-status", ({ payload }) => update(payload));
    const refresh = () => {
      void invoke<NetworkStatus>("network_status").then(update, (error: unknown) => {
        useNetworkStore.setState({ connectivity: "unknown" });
        console.warn("[network] failed to read system connectivity", error);
      });
    };
    window.addEventListener("norea-app-resumed", refresh);
    window.addEventListener("focus", refresh);
    refresh();
  } catch (error) {
    console.error("[network] failed to observe system connectivity", error);
  }
}
