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

it("uses the three-second default for existing settings saved before the timeout option", async () => {
  storage.set("norea-content-server", JSON.stringify({ state: { serverUrl: "http://server", deviceName: "Tablet", syncMode: "periodic", syncIntervalMinutes: 30 }, version: 1 }));
  await useContentSyncStore.persist.rehydrate();
  expect(useContentSyncStore.getState()).toMatchObject({ lookupTimeoutSeconds: 3, syncMode: "periodic", syncIntervalMinutes: 30 });
});

it.each([[true, "changes"], [false, "manual"]])("migrates legacy automatic sync %s to %s", async (autoSync, syncMode) => {
  storage.set("norea-content-server", JSON.stringify({ state: { serverUrl: "http://server", deviceName: "Tablet", autoSync }, version: 0 }));
  await useContentSyncStore.persist.rehydrate();
  expect(useContentSyncStore.getState()).toMatchObject({ serverUrl: "http://server", deviceName: "Tablet", syncMode, syncIntervalMinutes: 15 });
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
