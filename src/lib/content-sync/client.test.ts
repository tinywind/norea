import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { useNetworkStore } from "../network";
import { contentServerRequest, withContentServerLookup } from "./client";

const abortSignalAny = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
beforeEach(() => { Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true }); });
afterEach(() => {
  Object.defineProperty(AbortSignal, "any", abortSignalAny);
  useNetworkStore.setState({ connectivity: "online" });
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reaches a configured LAN server even when public Internet connectivity is unavailable", async () => {
  useNetworkStore.setState({ connectivity: "offline" });
  vi.mocked(nativeFetch).mockResolvedValue(Response.json({ apiVersion: 1 }));
  await expect(contentServerRequest("http://127.0.0.1:7788", "/capabilities")).resolves.toEqual({ apiVersion: 1 });
});

it("serializes device registration as JSON and sends credentials only in the authorization header", async () => {
  vi.mocked(nativeFetch).mockResolvedValue(Response.json({ version: 1 }));
  await contentServerRequest("http://127.0.0.1:7788", "/devices/register", "private-token", "POST", { deviceName: "Tablet" });
  const [url, init] = vi.mocked(nativeFetch).mock.calls[0]!;
  expect(url).toBe("http://127.0.0.1:7788/api/v1/devices/register");
  expect(init?.body).toBe('{"deviceName":"Tablet"}');
  expect(init?.headers).toMatchObject({ Authorization: "Bearer private-token", "Content-Type": "application/json" });
});

it("browses with caller cancellation when AbortSignal.any is unavailable", async () => {
  vi.mocked(nativeFetch).mockResolvedValue(Response.json({ items: [], total: 0, hasMore: false }));
  const controller = new AbortController();
  await expect(contentServerRequest("http://server", "/catalog/works", undefined, "GET", undefined, controller.signal))
    .resolves.toEqual({ items: [], total: 0, hasMore: false });
});

it("propagates caller cancellation and removes its listener after lookup", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  let activeSignal: AbortSignal | undefined;
  const pending = withContentServerLookup(signal => {
    activeSignal = signal;
    return new Promise(() => {});
  }, 30, controller.signal);
  const reason = new Error("Navigation cancelled");
  const rejected = expect(pending).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
  expect(activeSignal?.aborted).toBe(true);
  expect(activeSignal?.reason).toBe(reason);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("does not start an already cancelled lookup", async () => {
  const controller = new AbortController();
  const reason = new Error("Navigation cancelled");
  controller.abort(reason);
  let started = false;
  await expect(withContentServerLookup(async () => { started = true; }, 30, controller.signal)).rejects.toBe(reason);
  expect(started).toBe(false);
});

it("times out response body reads and clears the request timer", async () => {
  vi.useFakeTimers();
  vi.mocked(nativeFetch).mockResolvedValue(new Response(new ReadableStream(), { headers: { "Content-Type": "application/json" } }));
  const pending = contentServerRequest("http://server", "/catalog/works", undefined, "GET", undefined, new AbortController().signal);
  await Promise.all([expect(pending).rejects.toThrow("timed out"), vi.advanceTimersByTimeAsync(30_000)]);
  expect(vi.getTimerCount()).toBe(0);
});
