import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { connectPluginVpnDownloadWorker, validatePluginVpnDownloadWorker } from "./plugin-vpn-download-workers";

const worker = { rangeId: "range", slot: 0 as const, generation: 8 };
beforeEach(() => vi.clearAllMocks());

it("preserves confirmed native tunnel loss through authoritative chapter validation", async () => {
  vi.mocked(invoke).mockRejectedValue({ code: "vpn-worker-tunnel-lost", message: "Tunnel completion failed" });
  await expect(validatePluginVpnDownloadWorker(worker)).rejects.toMatchObject({ code: "plugin-vpn-unavailable", message: expect.stringContaining("Tunnel completion failed") });
});

it("classifies an engine connection failure without converting local database or stale-owner errors", async () => {
  vi.mocked(invoke).mockRejectedValueOnce({ code: "vpn-worker-connection-failed", message: "TLS connection failed" });
  await expect(connectPluginVpnDownloadWorker(worker, { id: "profile", hash: "hash" })).rejects.toMatchObject({ code: "plugin-vpn-unavailable" });
  const local = { code: "vpn-worker-runtime-error", message: "Approval database unavailable" };
  vi.mocked(invoke).mockRejectedValueOnce(local);
  await expect(connectPluginVpnDownloadWorker(worker, { id: "profile", hash: "hash" })).rejects.toBe(local);
  vi.mocked(invoke).mockRejectedValueOnce(local);
  await expect(validatePluginVpnDownloadWorker(worker)).rejects.toBe(local);
});
