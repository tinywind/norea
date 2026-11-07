import { beforeEach, describe, expect, it, vi } from "vitest";
const ordinary = vi.hoisted(() => ({ sourceWorkConcurrency: 3 }));
vi.mock("./browse", () => ({ useBrowseStore: { getState: () => ordinary } }));
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
  it.each([[1, 1], [3, 3], [8, 3]])("uses ordinary concurrency %s for an absent first VPN choice, bounded at %s", (concurrency, expected) => {
    ordinary.sourceWorkConcurrency = concurrency;
    try {
      expect(normalizeVpnDownloadSettings(null).workerCount).toBe(expected);
      expect(normalizeVpnDownloadSettings({ workerCount: 7 }).workerCount).toBe(7);
    } finally { ordinary.sourceWorkConcurrency = 3; }
  });

  it("starts disabled with fixed pause policies and normalizes earlier replacement choices", () => {
    expect(normalizeVpnDownloadSettings(null)).toEqual({ mode: "off", workerCount: 3, captchaPolicy: "pause", cloudflarePolicy: "pause", resumeAfterRestart: true, useTestedServers: true });
    expect(normalizeVpnDownloadSettings({ captchaPolicy: "pause", cloudflarePolicy: "pause" }))
      .toEqual({ mode: "off", workerCount: 3, captchaPolicy: "pause", cloudflarePolicy: "pause", resumeAfterRestart: true, useTestedServers: true });
    expect(normalizeVpnDownloadSettings({ useTestedServers: false }).useTestedServers).toBe(false);
    useVpnDownloadStore.getState().setMode("parallel");
    useVpnDownloadStore.getState().setCaptchaPolicy("nextProfile");
    expect(useVpnDownloadStore.getState()).toMatchObject({ mode: "parallel", captchaPolicy: "nextProfile", cloudflarePolicy: "pause" });
  });

  it("bounds simultaneous workers independently of retained profile capacity", () => {
    const { setWorkerCount } = useVpnDownloadStore.getState();
    setWorkerCount(20);
    expect(useVpnDownloadStore.getState().workerCount).toBe(10);
    setWorkerCount(7.8);
    expect(useVpnDownloadStore.getState().workerCount).toBe(7);
    setWorkerCount(0);
    expect(useVpnDownloadStore.getState().workerCount).toBe(1);
    setWorkerCount(Number.NaN);
    expect(useVpnDownloadStore.getState().workerCount).toBe(3);
  });

  it("rejects malformed persisted choices without starting an automatic run", () => {
    expect(normalizeVpnDownloadSettings({ mode: "unknown", workerCount: 100, captchaPolicy: true, cloudflarePolicy: "nextProfile" }))
      .toEqual({ mode: "off", workerCount: 10, captchaPolicy: "pause", cloudflarePolicy: "pause", resumeAfterRestart: true, useTestedServers: true });
    expect(normalizeVpnDownloadSettings({ mode: "single", workerCount: 1.8, captchaPolicy: "nextProfile" }))
      .toEqual({ mode: "single", workerCount: 1, captchaPolicy: "pause", cloudflarePolicy: "pause", resumeAfterRestart: true, useTestedServers: true });
  });

  it("resumes after an ordinary restart unless the stored choice turned it off", () => {
    expect(normalizeVpnDownloadSettings({ mode: "parallel", workerCount: 2 }).resumeAfterRestart).toBe(true);
    expect(normalizeVpnDownloadSettings({ resumeAfterRestart: "no" }).resumeAfterRestart).toBe(true);
    expect(normalizeVpnDownloadSettings({ resumeAfterRestart: false }).resumeAfterRestart).toBe(false);
    useVpnDownloadStore.getState().setResumeAfterRestart(false);
    expect(useVpnDownloadStore.getState().resumeAfterRestart).toBe(false);
  });
});
