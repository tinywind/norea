import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal("window", { localStorage: globalThis.localStorage });
});
import { normalizeVpnDownloadSettings, useVpnDownloadStore } from "./vpn-download";

beforeEach(() => useVpnDownloadStore.setState(normalizeVpnDownloadSettings(null)));

describe("VPN download settings", () => {
  it("starts disabled with one shared browser worker and fixed challenge pause policies", () => {
    expect(normalizeVpnDownloadSettings(null)).toEqual({
      mode: "off", workerCount: 1, captchaPolicy: "pause", cloudflarePolicy: "pause",
      resumeAfterRestart: true, useTestedServers: true,
    });
    expect(normalizeVpnDownloadSettings({ useTestedServers: false }).useTestedServers).toBe(false);
    useVpnDownloadStore.getState().setMode("parallel");
    expect(useVpnDownloadStore.getState()).toMatchObject({ mode: "parallel", workerCount: 1 });
  });

  it.each([0, 1, 3, 10, 20, 7.8, Number.NaN])("keeps one worker for the saved or submitted count %s", count => {
    expect(normalizeVpnDownloadSettings({ workerCount: count }).workerCount).toBe(1);
    useVpnDownloadStore.getState().setWorkerCount(count);
    expect(useVpnDownloadStore.getState().workerCount).toBe(1);
  });

  it("normalizes earlier parallel settings on rehydration before a run can start", async () => {
    localStorage.setItem("vpn-download-settings", JSON.stringify({
      state: { mode: "parallel", workerCount: 10, captchaPolicy: "nextProfile", cloudflarePolicy: "nextProfile" },
      version: 0,
    }));
    await useVpnDownloadStore.persist.rehydrate();
    expect(useVpnDownloadStore.getState()).toMatchObject({
      mode: "parallel", workerCount: 1, captchaPolicy: "pause", cloudflarePolicy: "pause",
    });
  });

  it("rejects malformed persisted choices without starting an automatic run", () => {
    expect(normalizeVpnDownloadSettings({ mode: "unknown", workerCount: 100, captchaPolicy: true, cloudflarePolicy: "nextProfile" }))
      .toEqual({ mode: "off", workerCount: 1, captchaPolicy: "pause", cloudflarePolicy: "pause", resumeAfterRestart: true, useTestedServers: true });
  });

  it("resumes after an ordinary restart unless the stored choice turned it off", () => {
    expect(normalizeVpnDownloadSettings({ mode: "parallel", workerCount: 2 }).resumeAfterRestart).toBe(true);
    expect(normalizeVpnDownloadSettings({ resumeAfterRestart: "no" }).resumeAfterRestart).toBe(true);
    expect(normalizeVpnDownloadSettings({ resumeAfterRestart: false }).resumeAfterRestart).toBe(false);
    useVpnDownloadStore.getState().setResumeAfterRestart(false);
    expect(useVpnDownloadStore.getState().resumeAfterRestart).toBe(false);
  });
});
