import { afterAll, beforeEach, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});
vi.stubGlobal("window", { localStorage: globalThis.localStorage });
const { useUserStateStore } = await import("./user-state");
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  storage.clear();
  useUserStateStore.setState(useUserStateStore.getInitialState());
});

it("requires a separate opt-in for every server and preserves a paused server's runtime", () => {
  const state = useUserStateStore.getState();
  expect(state.enabledByServer).toEqual({});
  state.setEnabled("https://one.example/", true);
  state.setRuntime("https://one.example", "error", "Connection unavailable");
  expect(useUserStateStore.getState().enabledByServer).toEqual({ "https://one.example": true });
  expect(useUserStateStore.getState().enabledByServer["https://two.example"]).toBeUndefined();
  state.setEnabled("https://one.example", false);
  expect(useUserStateStore.getState().enabledByServer).toEqual({});
  expect(useUserStateStore.getState().runtimeByServer["https://one.example"]?.error).toBe("Connection unavailable");
});

it("persists only the opt-in, without runtime errors or another device's state", async () => {
  useUserStateStore.getState().setEnabled("https://one.example", true);
  useUserStateStore.getState().setRuntime("https://one.example", "error", "Temporary failure detail");
  const saved = JSON.parse(storage.get("norea-user-state")!);
  expect(saved.state).toEqual({ enabledByServer: { "https://one.example": true } });
  useUserStateStore.setState({ enabledByServer: {}, runtimeByServer: {} });
  storage.set("norea-user-state", JSON.stringify(saved));
  await useUserStateStore.persist.rehydrate();
  expect(useUserStateStore.getState().enabledByServer["https://one.example"]).toBe(true);
  expect(useUserStateStore.getState().runtimeByServer).toEqual({});
});

it("rejects malformed saved opt-ins and ignores injected runtime state", async () => {
  storage.set("norea-user-state", JSON.stringify({
    version: 1,
    state: {
      enabledByServer: { "https://one.example/": true, "https://two.example": "true", "file:///private": true, "not a URL": true },
      runtimeByServer: { "https://one.example": { phase: "syncing", error: "saved error", revision: 99 } },
    },
  }));
  await useUserStateStore.persist.rehydrate();
  expect(useUserStateStore.getState().enabledByServer).toEqual({ "https://one.example": true });
  expect(useUserStateStore.getState().runtimeByServer).toEqual({});
});

it("keeps runtime notifications isolated when a different server finishes later", () => {
  useUserStateStore.getState().setRuntime("https://one.example", "syncing");
  useUserStateStore.getState().setRuntime("https://two.example", "idle");
  useUserStateStore.getState().setRuntime("https://one.example", "error", "Offline");
  expect(useUserStateStore.getState().runtimeByServer).toEqual({
    "https://one.example": { phase: "error", error: "Offline", revision: 2 },
    "https://two.example": { phase: "idle", error: null, revision: 1 },
  });
});

it("tracks transient epochMismatch and omits default retention configs from persistence", async () => {
  const mismatch = {
    serverUrl: "https://one.example",
    localWorkspaceId: "ws-1",
    localEpoch: "ep-1",
    serverWorkspaceId: "ws-1",
    serverEpoch: "ep-2",
    headRevision: 4,
    detectedAt: 1000,
  };
  useUserStateStore.getState().setEpochMismatch("https://one.example/", mismatch);
  useUserStateStore.getState().setRetentionStatus?.("https://one.example/", {
    seedAllowed: true,
    seedCutoffAt: 1_700_000_000_000,
  });
  useUserStateStore.getState().setRetention?.("https://one.example/", { pruneNonLibraryEnabled: false });

  expect(useUserStateStore.getState().runtimeByServer["https://one.example"]?.epochMismatch).toEqual(mismatch);
  const savedDefault = JSON.parse(storage.get("norea-user-state")!);
  expect(savedDefault.state).toEqual({ enabledByServer: {} });

  // Preserved across syncing, error, and idle; cleared only via explicit setEpochMismatch(..., null).
  useUserStateStore.getState().setRuntime("https://one.example", "syncing");
  expect(useUserStateStore.getState().runtimeByServer["https://one.example"]?.epochMismatch).toEqual(mismatch);
  useUserStateStore.getState().setRuntime("https://one.example", "error", "Epoch changed");
  expect(useUserStateStore.getState().runtimeByServer["https://one.example"]?.epochMismatch).toEqual(mismatch);
  useUserStateStore.getState().setRuntime("https://one.example", "idle");
  expect(useUserStateStore.getState().runtimeByServer["https://one.example"]?.epochMismatch).toEqual(mismatch);
  useUserStateStore.getState().setEpochMismatch("https://one.example/", null);
  expect(useUserStateStore.getState().runtimeByServer["https://one.example"]?.epochMismatch).toBeUndefined();
  expect("epochMismatch" in useUserStateStore.getState().runtimeByServer["https://one.example"]!).toBe(false);

  // Explicit opt-in retention persists cleanly.
  useUserStateStore.getState().setRetention?.("https://one.example", {
    pruneNonLibraryEnabled: true,
    pruneNonLibraryDays: 45,
  });
  const savedOptIn = JSON.parse(storage.get("norea-user-state")!);
  expect(savedOptIn.state.retentionByServer).toEqual({
    "https://one.example": {
      pruneNonLibraryEnabled: true,
      pruneNonLibraryDays: 45,
      stripTimestampsEnabled: false,
      stripTimestampsDays: 90,
    },
  });
  useUserStateStore.setState({ enabledByServer: {}, runtimeByServer: {}, retentionByServer: {}, retentionStatusByServer: {} });
  storage.set("norea-user-state", JSON.stringify(savedOptIn));
  await useUserStateStore.persist.rehydrate();
  expect(useUserStateStore.getState().retentionByServer?.["https://one.example"]).toEqual({
    pruneNonLibraryEnabled: true,
    pruneNonLibraryDays: 45,
    stripTimestampsEnabled: false,
    stripTimestampsDays: 90,
  });
  expect(useUserStateStore.getState().runtimeByServer).toEqual({});
});
