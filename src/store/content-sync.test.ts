import { afterAll, beforeEach, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});
vi.stubGlobal("window", { localStorage: globalThis.localStorage });
const { useContentSyncStore } = await import("./content-sync");
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  storage.clear();
  useContentSyncStore.setState(useContentSyncStore.getInitialState());
});

it("defaults to manual sync and persists the selected mode and interval", async () => {
  expect(useContentSyncStore.getState().syncMode).toBe("manual");
  useContentSyncStore.getState().setSyncMode("periodic");
  useContentSyncStore.getState().setSyncIntervalMinutes(30);
  await useContentSyncStore.persist.rehydrate();
  expect(useContentSyncStore.getState()).toMatchObject({ syncMode: "periodic", syncIntervalMinutes: 30 });
});

it("defaults chapter lookup to three seconds and persists a bounded timeout", async () => {
  expect(useContentSyncStore.getState().lookupTimeoutSeconds).toBe(3);
  useContentSyncStore.getState().setLookupTimeoutSeconds(8);
  await useContentSyncStore.persist.rehydrate();
  expect(useContentSyncStore.getState().lookupTimeoutSeconds).toBe(8);
  useContentSyncStore.getState().setLookupTimeoutSeconds(0);
  expect(useContentSyncStore.getState().lookupTimeoutSeconds).toBe(1);
  useContentSyncStore.getState().setLookupTimeoutSeconds(Number.NaN);
  expect(useContentSyncStore.getState().lookupTimeoutSeconds).toBe(3);
});

it("discards settings from a different schema without translating automatic sync", async () => {
  storage.set("norea-content-server", JSON.stringify({ state: { serverUrl: "http://server", deviceName: "Tablet", autoSync: true }, version: 0 }));
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await useContentSyncStore.persist.rehydrate();
    expect(useContentSyncStore.getState()).toMatchObject({ serverUrl: "", deviceName: "Norea", syncMode: "manual", syncIntervalMinutes: 15 });
  } finally {
    error.mockRestore();
  }
});

it("bounds the sync interval and keeps device keys outside portable settings", () => {
  useContentSyncStore.getState().setSyncIntervalMinutes(0);
  expect(useContentSyncStore.getState().syncIntervalMinutes).toBe(1);
  useContentSyncStore.getState().setSyncIntervalMinutes(2000);
  expect(useContentSyncStore.getState().syncIntervalMinutes).toBe(1440);
  useContentSyncStore.getState().setSyncIntervalMinutes(Number.NaN);
  expect(useContentSyncStore.getState().syncIntervalMinutes).toBe(15);
  useContentSyncStore.setState({ deviceKey: "test-key" });
  expect(storage.get("norea-content-server")).not.toContain("test-key");
  expect(storage.get("norea-content-server")).not.toContain("reader");
});
