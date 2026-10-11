import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { registerContentDevice } from "./device";

const storage = new Map<string, string>();
const capabilities = { apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: false };
beforeEach(() => {
  storage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.mocked(nativeFetch).mockImplementation(async (url) => Response.json(String(url).endsWith("/capabilities")
    ? capabilities : { id: "device", deviceName: "Tablet" }));
});
afterEach(() => vi.unstubAllGlobals());

it("registers once under concurrent initialization and persists the key before sending it", async () => {
  const first = registerContentDevice("http://server/", "Tablet");
  const second = registerContentDevice("http://server", "Tablet");
  expect(first).toBe(second);
  const key = await first;
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(storage.get("norea-content-device:http://server")).toBe(key);
  const calls = vi.mocked(nativeFetch).mock.calls;
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[1]![1]!.body as string)).toEqual({ deviceKey: key, deviceName: "Tablet" });
});

it("does not register after a cancelled capability lookup completes late", async () => {
  const controller = new AbortController();
  vi.mocked(nativeFetch).mockImplementationOnce(async () => {
    controller.abort(new Error("Lookup expired"));
    return Response.json(capabilities);
  });
  await expect(registerContentDevice("http://server", "Tablet", controller.signal)).rejects.toThrow("Lookup expired");
  expect(nativeFetch).toHaveBeenCalledOnce();
});

it("reuses the persisted key after a module restart and isolates different servers", async () => {
  const first = await registerContentDevice("http://server:80/", "Tablet");
  vi.resetModules();
  const restarted = await import("./device");
  expect(await restarted.registerContentDevice("http://server", "Renamed tablet")).toBe(first);
  expect(await restarted.registerContentDevice("http://other", "Tablet")).not.toBe(first);
  expect(await restarted.registerContentDevice("http://server/other", "Tablet")).not.toBe(first);
});

it.each([401, 403])("retains the key after status %i and never generates a replacement", async (status) => {
  vi.mocked(nativeFetch).mockImplementation(async (url) => String(url).endsWith("/capabilities")
    ? Response.json(capabilities) : new Response(null, { status }));
  await expect(registerContentDevice("http://server", "Tablet")).rejects.toThrow(String(status));
  const saved = storage.get("norea-content-device:http://server");
  await expect(registerContentDevice("http://server", "Tablet")).rejects.toThrow(String(status));
  expect(storage.get("norea-content-device:http://server")).toBe(saved);
  const bodies = vi.mocked(nativeFetch).mock.calls.filter(([url]) => String(url).endsWith("/devices/register"))
    .map(([, init]) => JSON.parse(init!.body as string).deviceKey);
  expect(bodies).toEqual([saved, saved]);
});

it.each([
  { ...capabilities, apiVersion: 2 },
  { ...capabilities, authentication: "account" },
  { ...capabilities, personalStateSync: true },
  { ...capabilities, packageVersion: 2 },
])("rejects incompatible capabilities before revealing or generating a credential", async (response) => {
  vi.mocked(nativeFetch).mockResolvedValue(Response.json(response));
  await expect(registerContentDevice("http://server", "Tablet")).rejects.toThrow("incompatible");
  expect(nativeFetch).toHaveBeenCalledOnce();
  expect(storage.size).toBe(0);
});

it("stops before registration if persistence fails or an existing key is malformed", async () => {
  storage.set("norea-content-device:http://server", "bad-key");
  await expect(registerContentDevice("http://server", "Tablet")).rejects.toThrow("invalid");
  expect(storage.get("norea-content-device:http://server")).toBe("bad-key");
  storage.clear();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("storage full"); } });
  await expect(registerContentDevice("http://server", "Tablet")).rejects.toThrow("storage full");
  expect(vi.mocked(nativeFetch).mock.calls.every(([url]) => String(url).endsWith("/capabilities"))).toBe(true);
});
