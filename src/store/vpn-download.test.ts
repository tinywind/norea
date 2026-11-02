import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
import { normalizeVpnDownloadSettings, useVpnDownloadStore } from "./vpn-download";

beforeEach(() => useVpnDownloadStore.setState({ mode: "off", workerCount: 2, captchaPolicy: "pause", cloudflarePolicy: "pause" }));

describe("VPN download settings", () => {
  it("starts disabled and requires separate opt-in for each challenge type", () => {
    expect(normalizeVpnDownloadSettings(null)).toEqual({ mode: "off", workerCount: 2, captchaPolicy: "pause", cloudflarePolicy: "pause" });
    useVpnDownloadStore.getState().setMode("parallel");
    useVpnDownloadStore.getState().setCaptchaPolicy("nextProfile");
    expect(useVpnDownloadStore.getState()).toMatchObject({ mode: "parallel", captchaPolicy: "nextProfile", cloudflarePolicy: "pause" });
  });

  it("bounds simultaneous workers independently of retained profile capacity", () => {
    const { setWorkerCount } = useVpnDownloadStore.getState();
    setWorkerCount(20);
    expect(useVpnDownloadStore.getState().workerCount).toBe(2);
    setWorkerCount(0);
    expect(useVpnDownloadStore.getState().workerCount).toBe(1);
    setWorkerCount(Number.NaN);
    expect(useVpnDownloadStore.getState().workerCount).toBe(2);
  });

  it("rejects malformed persisted choices without enabling automatic replacement", () => {
    expect(normalizeVpnDownloadSettings({ mode: "unknown", workerCount: 100, captchaPolicy: true, cloudflarePolicy: "nextProfile" }))
      .toEqual({ mode: "off", workerCount: 2, captchaPolicy: "pause", cloudflarePolicy: "nextProfile" });
    expect(normalizeVpnDownloadSettings({ mode: "single", workerCount: 1.8, captchaPolicy: "nextProfile" }))
      .toEqual({ mode: "single", workerCount: 1, captchaPolicy: "nextProfile", cloudflarePolicy: "pause" });
  });
});
