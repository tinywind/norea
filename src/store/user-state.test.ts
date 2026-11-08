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
