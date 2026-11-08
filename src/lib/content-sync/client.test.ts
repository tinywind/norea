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

it("retains the server's migration conflict reason for the Details view", async () => {
  vi.mocked(nativeFetch).mockResolvedValue(Response.json({
    statusCode: 409, error: "Conflict", message: "Work migration: target differs from the explicitly selected copy",
  }, { status: 409 }));
  await expect(contentServerRequest("http://server", "/works/source/finalize-migration", "device", "POST", {}))
    .rejects.toMatchObject({ status: 409, message: "Work migration: target differs from the explicitly selected copy" });
});

it("keeps the migration verification deadline separate from ordinary lookup deadlines", async () => {
  vi.useFakeTimers();
  vi.mocked(nativeFetch).mockResolvedValue(new Response(new ReadableStream(), { headers: { "Content-Type": "application/json" } }));
  const pending = contentServerRequest("http://server", "/works/source/finalize-migration", "device", "POST", {}, undefined, 300);
  const rejected = expect(pending).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(vi.mocked(nativeFetch).mock.calls.at(-1)![1]!.signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(270_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  new TypeError("Failed to fetch"),
  "error sending request for url (http://content.test/api/v1/works)",
])("marks native connection failures as retryable content server transport errors", async cause => {
  vi.mocked(nativeFetch).mockRejectedValue(cause);
  await expect(contentServerRequest("http://content.test", "/works")).rejects.toMatchObject({
    name: "ContentServerTransportError", code: "content-server-request-failed", retryable: true, cause,
  });
});

it("marks only its own lookup deadline as a retryable transport failure", async () => {
  vi.useFakeTimers();
  const pending = withContentServerLookup(() => new Promise(() => {}), 2);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "ContentServerTransportError", code: "content-server-request-failed", retryable: true,
    message: "Content server lookup timed out.",
  });
  await vi.advanceTimersByTimeAsync(2_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the caller cancellation reason when native fetch reports its own cancellation", async () => {
  const controller = new AbortController();
  vi.mocked(nativeFetch).mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("Request cancelled")), { once: true });
  }));
  const pending = contentServerRequest("http://content.test", "/works", undefined, "GET", undefined, controller.signal);
  const reason = new Error("The user cancelled this migration.");
  const rejected = expect(pending).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
});

it("keeps malformed JSON separate from a retryable transport failure", async () => {
  vi.mocked(nativeFetch).mockResolvedValue(new Response("{invalid", { headers: { "Content-Type": "application/json" } }));
  const error = await contentServerRequest("http://content.test", "/works").catch((value: unknown) => value);
  expect(error).toBeInstanceOf(SyntaxError);
  expect(error).not.toHaveProperty("retryable");
});

it("does not classify lookup validation failures as transport errors", async () => {
  const invalid = new Error("The server work identity does not match its metadata.");
  await expect(withContentServerLookup(async () => { throw invalid; }, 30)).rejects.toBe(invalid);
  expect(invalid).not.toHaveProperty("retryable");
});

it("validates HTTP request headers before entering the native transport", async () => {
  vi.mocked(nativeFetch).mockResolvedValue(Response.json({}));
  const error = await contentServerRequest("http://content.test", "/works", "invalid\nheader").catch((value: unknown) => value);
  expect(error).toBeInstanceOf(TypeError);
  expect(error).not.toHaveProperty("retryable");
  expect(nativeFetch).not.toHaveBeenCalled();
});

it("rejects an unsupported protocol without entering the native transport", async () => {
  const error = await contentServerRequest("file:///content", "/works").catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toHaveProperty("retryable");
  expect(nativeFetch).not.toHaveBeenCalled();
});
