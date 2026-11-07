import { invoke } from "@tauri-apps/api/core";
import { usePluginVpnStore } from "../store/plugin-vpn";
import { isAbortError, requestAbortedError } from "./abort";
import { describeError } from "./errors";
import { errorHttpStatus } from "./http/status-error";
import type { VpnDownloadWorkerRef } from "./tasks/vpn-download-types";

export interface PluginVpnTransportCursor {
  routeGeneration: number;
  nextRequestId: number;
}

export interface PluginVpnTransportFailure {
  routeGeneration: number;
  requestId: number;
  host: string;
  port: number;
  kind: "dns" | "tcp" | "tunnel" | "proxy";
  message: string;
}

export class PluginVpnTransportError extends Error {
  readonly code = "plugin-vpn-transport" as const;

  constructor(readonly failure: PluginVpnTransportFailure, readonly cause: unknown) {
    super(`VPN ${failure.kind.toUpperCase()} failure observed for ${failure.host}:${failure.port}: ${failure.message}. ${describeError(cause)}`);
    this.name = "PluginVpnTransportError";
  }
}

interface TransportAttempt {
  overlapped: boolean;
}

const activeAttempts = new Map<string, Set<TransportAttempt>>();
const NETWORK_FAILURE = /\b(?:net::ERR_(?:TIMED_OUT|CONNECTION_[A-Z_]+|NAME_NOT_RESOLVED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_CHANGED|EMPTY_RESPONSE)|failed to fetch|network error|timed out|timeout)\b/i;

/**
 * Adds a same-route, same-target proxy observation to a failed browser attempt.
 * CONNECT does not carry a source ID, so overlapping attempts are never matched.
 * Diagnostics do not probe, retry, change routes, or alter tunnel health.
 */
export function withPluginVpnTransportDiagnostics<T>(
  url: string,
  worker: VpnDownloadWorkerRef | null,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(requestAbortedError());
  if (!worker && !usePluginVpnStore.getState().enabled) return run();
  const key = worker ? `vpn:${worker.slot}:${worker.generation}` : "foreground";
  const active = activeAttempts.get(key) ?? new Set<TransportAttempt>();
  const attempt = { overlapped: active.size > 0 };
  for (const other of active) other.overlapped = true;
  active.add(attempt);
  activeAttempts.set(key, active);

  return observeAttempt(url, worker, attempt, run, signal).finally(() => {
    active.delete(attempt);
    if (active.size === 0) activeAttempts.delete(key);
  });
}

async function observeAttempt<T>(
  url: string,
  worker: VpnDownloadWorkerRef | null,
  attempt: TransportAttempt,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const cursor = await readDiagnostic<PluginVpnTransportCursor>("plugin_vpn_transport_cursor", { worker }, signal);
  if (signal?.aborted) throw requestAbortedError();
  try {
    return await run();
  } catch (error) {
    if (!cursor || attempt.overlapped || signal?.aborted || isAbortError(error)
      || errorHttpStatus(error) !== undefined || !NETWORK_FAILURE.test(describeError(error))) throw error;
    const failure = await readDiagnostic<PluginVpnTransportFailure>("plugin_vpn_transport_failure", { worker, cursor, url }, signal);
    if (!failure || attempt.overlapped || signal?.aborted) throw error;
    throw new PluginVpnTransportError(failure, error);
  }
}

/** Diagnostic IPC is optional and cannot keep a browser operation waiting indefinitely. */
function readDiagnostic<T>(command: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T | null> {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancelled);
      resolve(value);
    };
    const cancelled = () => finish(null);
    const timeout = setTimeout(cancelled, 1_000);
    signal?.addEventListener("abort", cancelled, { once: true });
    try {
      void invoke<T | null>(command, args).then(finish, cancelled);
    } catch {
      cancelled();
    }
  });
}
