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

import {
  DOWNLOAD_RECOVERY_SETTINGS_KEY,
  getDownloadRecoveryPolicy,
  normalizeDownloadRecoveryPolicy,
  useDownloadRecoveryStore,
} from "./download-recovery";

const defaults = {
  forbiddenAction: "pause",
  transientAction: "pause",
  rateLimitAction: "pause",
  notFoundAction: "skip",
  maxRetries: 2,
  retryDelaySeconds: 30,
  maxProfileChanges: 1,
  rotateFingerprintOnVpnChange: false,
};

beforeEach(() => useDownloadRecoveryStore.setState(normalizeDownloadRecoveryPolicy(null)));

describe("download recovery policy", () => {
  it.each([null, undefined, false, [], "retry"])("uses explicit opt-in recovery defaults for %s", (value) => {
    expect(normalizeDownloadRecoveryPolicy(value)).toEqual(defaults);
  });

  it("accepts only the actions supported for each error", () => {
    expect(normalizeDownloadRecoveryPolicy({
      forbiddenAction: "nextProfile",
      transientAction: "resetSite",
      rateLimitAction: "nextProfile",
      notFoundAction: "retry",
    })).toEqual(defaults);
    expect(normalizeDownloadRecoveryPolicy({
      forbiddenAction: "resetSite",
      transientAction: "nextProfile",
      rateLimitAction: "retry",
      notFoundAction: "pause",
    })).toEqual({
      ...defaults, forbiddenAction: "resetSite", transientAction: "nextProfile",
      rateLimitAction: "retry", notFoundAction: "pause",
    });
  });

  it("bounds attempts and waiting time and rejects nonnumeric persisted values", () => {
    expect(normalizeDownloadRecoveryPolicy({
      maxRetries: 20, retryDelaySeconds: 9_000, maxProfileChanges: 10,
    })).toMatchObject({ maxRetries: 5, retryDelaySeconds: 3_600, maxProfileChanges: 3 });
    expect(normalizeDownloadRecoveryPolicy({
      maxRetries: -1, retryDelaySeconds: -1, maxProfileChanges: -1,
    })).toMatchObject({ maxRetries: 0, retryDelaySeconds: 5, maxProfileChanges: 0 });
    expect(normalizeDownloadRecoveryPolicy({
      maxRetries: 2.9, retryDelaySeconds: 30.9, maxProfileChanges: 1.9,
    })).toMatchObject({ maxRetries: 2, retryDelaySeconds: 30, maxProfileChanges: 1 });
    expect(normalizeDownloadRecoveryPolicy({
      maxRetries: Number.NaN, retryDelaySeconds: "60", maxProfileChanges: Number.POSITIVE_INFINITY,
    })).toEqual(defaults);
  });

  it("requires an explicit boolean choice to refresh the VPN fingerprint", () => {
    for (const value of [undefined, null, "true", 1, false]) {
      expect(normalizeDownloadRecoveryPolicy({ rotateFingerprintOnVpnChange: value }).rotateFingerprintOnVpnChange).toBe(false);
    }
    useDownloadRecoveryStore.getState().setPolicy({ rotateFingerprintOnVpnChange: true });
    expect(getDownloadRecoveryPolicy().rotateFingerprintOnVpnChange).toBe(true);
  });

  it("updates one choice without replacing other policy choices", () => {
    useDownloadRecoveryStore.getState().setPolicy({ forbiddenAction: "retry", retryDelaySeconds: 60 });
    useDownloadRecoveryStore.getState().setPolicy({ transientAction: "nextProfile", maxRetries: 100 });
    expect(getDownloadRecoveryPolicy()).toEqual({
      ...defaults, forbiddenAction: "retry", transientAction: "nextProfile",
      retryDelaySeconds: 60, maxRetries: 5,
    });
  });

  it("persists only policy and normalizes saved values on rehydration", async () => {
    localStorage.setItem(DOWNLOAD_RECOVERY_SETTINGS_KEY, JSON.stringify({
      state: { forbiddenAction: "resetSite", maxRetries: 100, sourceId: "private-source", attempt: 4 },
      version: 0,
    }));
    await useDownloadRecoveryStore.persist.rehydrate();
    expect(getDownloadRecoveryPolicy()).toEqual({ ...defaults, forbiddenAction: "resetSite", maxRetries: 5 });
    useDownloadRecoveryStore.getState().setPolicy({ retryDelaySeconds: 45 });
    expect(JSON.parse(localStorage.getItem(DOWNLOAD_RECOVERY_SETTINGS_KEY)!)).toEqual({
      state: { ...defaults, forbiddenAction: "resetSite", maxRetries: 5, retryDelaySeconds: 45 },
      version: 0,
    });
    expect(useDownloadRecoveryStore.getState().setPolicy).toBeTypeOf("function");
  });
});
