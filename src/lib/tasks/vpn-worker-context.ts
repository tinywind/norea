import type { ScraperExecutorId } from "./scraper-queue";
import type { VpnDownloadWorkerRef } from "./vpn-download-types";

const workers = new Map<string, Readonly<VpnDownloadWorkerRef>>();

export function vpnDownloadExecutor(worker: VpnDownloadWorkerRef): ScraperExecutorId {
  if ((worker.slot !== 0 && worker.slot !== 1) || !Number.isSafeInteger(worker.generation) || worker.generation <= 0 ||
      !worker.rangeId.trim() || worker.rangeId.length > 96 || /[\u0000-\u001f\u007f]/.test(worker.rangeId)) {
    throw new Error("VPN download worker identity is invalid.");
  }
  return `vpn:${worker.slot}:${worker.generation}`;
}

export function registerVpnDownloadWorkerContext(worker: VpnDownloadWorkerRef): () => void {
  const executor = vpnDownloadExecutor(worker);
  const current = workers.get(executor);
  if (current && current.rangeId !== worker.rangeId) throw new Error("VPN worker generation belongs to another range.");
  const context = Object.freeze({ ...worker });
  workers.set(executor, context);
  return () => {
    if (workers.get(executor) === context) workers.delete(executor);
  };
}

export function getVpnDownloadWorkerContext(executor: ScraperExecutorId): Readonly<VpnDownloadWorkerRef> | undefined {
  return workers.get(executor);
}
