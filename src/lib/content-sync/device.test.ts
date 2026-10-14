import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { registerContentDevice } from "./device";
import { contentServerRequest } from "./client";

const storage = new Map<string, string>();
const capabilities = { apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: false };
beforeEach(() => {
  storage.clear();
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue("TB320FC");
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.mocked(nativeFetch).mockImplementation(async (url) => Response.json(String(url).endsWith("/capabilities")
    ? capabilities : { id: "device", deviceName: "Tablet" }));
});
afterEach(() => vi.unstubAllGlobals());

it("registers the system device name before settings are opened and reuses registration", async () => {
  const key = await registerContentDevice("http://server", "");
  expect(await registerContentDevice("http://server", "")).toBe(key);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("get_default_device_name");
  const registration = vi.mocked(nativeFetch).mock.calls.find(([url]) => String(url).endsWith("/devices/register"))!;
  expect(JSON.parse(registration[1]!.body as string)).toEqual({ deviceKey: key, deviceName: "TB320FC" });
});

it("uses a custom name without querying the system and restores the default with the same key", async () => {
  const key = await registerContentDevice("http://server", "My tablet");
  expect(invoke).not.toHaveBeenCalled();
  expect(await registerContentDevice("http://server", "")).toBe(key);
  const registrations = vi.mocked(nativeFetch).mock.calls.filter(([url]) => String(url).endsWith("/devices/register"));
  expect(registrations.map(([, init]) => JSON.parse(init!.body as string))).toEqual([
    { deviceKey: key, deviceName: "My tablet" },
    { deviceKey: key, deviceName: "TB320FC" },
  ]);
});

it("does not contact the server if a default-name lookup fails or finishes after cancellation", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Device name unavailable"));
  await expect(registerContentDevice("http://server", "")).rejects.toThrow("Device name unavailable");
  const controller = new AbortController();
  vi.mocked(invoke).mockImplementationOnce(async () => {
    controller.abort(new Error("Lookup expired"));
    return "TB320FC";
  });
  await expect(registerContentDevice("http://server", "", controller.signal)).rejects.toThrow("Lookup expired");
  expect(nativeFetch).not.toHaveBeenCalled();
});

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

it("reuses completed registration for subsequent requests with independent lookup signals", async () => {
  const key = await registerContentDevice("http://server/", "Tablet", new AbortController().signal);
  expect(await registerContentDevice("http://server", "Tablet", new AbortController().signal)).toBe(key);
  expect(await registerContentDevice("http://server", "Tablet")).toBe(key);
  expect(nativeFetch).toHaveBeenCalledTimes(2);
});

it("updates a changed device name using the saved key before caching it again", async () => {
  const key = await registerContentDevice("http://server", "Tablet");
  expect(await registerContentDevice("http://server", "Renamed tablet")).toBe(key);
  expect(await registerContentDevice("http://server", "Renamed tablet")).toBe(key);
  const registrations = vi.mocked(nativeFetch).mock.calls.filter(([url]) => String(url).endsWith("/devices/register"));
  expect(registrations.map(([, init]) => JSON.parse(init!.body as string))).toEqual([
    { deviceKey: key, deviceName: "Tablet" },
    { deviceKey: key, deviceName: "Renamed tablet" },
  ]);
});

it("rejects an already cancelled lookup even when the device is registered", async () => {
  await registerContentDevice("http://server", "Tablet");
  const controller = new AbortController();
  controller.abort(new Error("Lookup expired"));
  await expect(registerContentDevice("http://server", "Tablet", controller.signal)).rejects.toThrow("Lookup expired");
  expect(nativeFetch).toHaveBeenCalledTimes(2);
});

it("preserves a cached device key when an authenticated API request reports revocation", async () => {
  const key = await registerContentDevice("http://server", "Tablet");
  vi.mocked(nativeFetch).mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(contentServerRequest("http://server", "/catalog?after=0", key)).rejects.toThrow("403");
  expect(await registerContentDevice("http://server", "Tablet")).toBe(key);
  expect(storage.get("norea-content-device:http://server")).toBe(key);
  expect(nativeFetch).toHaveBeenCalledTimes(3);
});

it("registers the saved key again if the server loses its device record", async () => {
  const key = await registerContentDevice("http://server", "Tablet");
  vi.mocked(nativeFetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(contentServerRequest("http://server", "/catalog?after=0", key)).rejects.toThrow("401");
  expect(await registerContentDevice("http://server", "Tablet")).toBe(key);
  expect(nativeFetch).toHaveBeenCalledTimes(5);
  const registrations = vi.mocked(nativeFetch).mock.calls.filter(([url]) => String(url).endsWith("/devices/register"));
  expect(registrations.map(([, init]) => JSON.parse(init!.body as string).deviceKey)).toEqual([key, key]);
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
