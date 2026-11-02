import { invoke } from "@tauri-apps/api/core";
import type { PluginVpnPhase } from "./plugin-vpn";
import type { SavedVpnProfile } from "./plugin-vpn-profiles";
import type { VpnDownloadWorkerRef } from "./tasks/vpn-download-types";
import { PluginVpnUnavailableError } from "./plugin-vpn-traffic";

export interface PluginVpnDownloadWorkerStatus {
  supported: boolean;
  worker: VpnDownloadWorkerRef;
  phase: PluginVpnPhase;
  proxyPort: number;
  profile: SavedVpnProfile | null;
  error: string | null;
}

export function getPluginVpnDownloadWorkerStatus(worker: VpnDownloadWorkerRef): Promise<PluginVpnDownloadWorkerStatus> {
  return invoke("plugin_vpn_download_worker_status", { worker });
}

export async function validatePluginVpnDownloadWorker(worker: VpnDownloadWorkerRef): Promise<PluginVpnDownloadWorkerStatus> {
  try { return await invoke("plugin_vpn_download_worker_validate", { worker }); }
  catch (error) { throw classifiedWorkerError(error, "vpn-worker-tunnel-lost"); }
}

export async function connectPluginVpnDownloadWorker(
  worker: VpnDownloadWorkerRef,
  profile: Pick<SavedVpnProfile, "id" | "hash">,
): Promise<PluginVpnDownloadWorkerStatus> {
  try { return await invoke("plugin_vpn_download_worker_connect", { worker, profileId: profile.id, expectedHash: profile.hash }); }
  catch (error) { throw classifiedWorkerError(error, "vpn-worker-connection-failed"); }
}

function classifiedWorkerError(error: unknown, code: string): unknown {
  return error !== null && typeof error === "object" && "code" in error && error.code === code && "message" in error && typeof error.message === "string"
    ? new PluginVpnUnavailableError(true, error.message) : error;
}

export function getPluginVpnDownloadGenerationFloor(): Promise<number> {
  return invoke("plugin_vpn_download_workers_generation_floor");
}

export function disconnectPluginVpnDownloadWorker(worker: VpnDownloadWorkerRef): Promise<PluginVpnDownloadWorkerStatus> {
  return invoke("plugin_vpn_download_worker_disconnect", { worker });
}

export async function stopPluginVpnDownloadWorkers(): Promise<void> {
  await invoke("plugin_vpn_download_workers_stop");
}
