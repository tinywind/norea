import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: boundary.invoke }));

let browser: EventTarget;
beforeEach(() => {
  vi.resetModules();
  boundary.invoke.mockReset().mockResolvedValue(undefined);
  browser = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, location: { href: "http://tauri.localhost/" } });
  vi.stubGlobal("window", browser);
});
afterEach(() => vi.unstubAllGlobals());

it("installs once and keeps the original error message and stack", async () => {
  const { installRuntimeCrashCapture } = await import("./runtime-crash");
  installRuntimeCrashCapture();
  installRuntimeCrashCapture();
  const failure = new Error("error-proof");
  browser.dispatchEvent(Object.assign(new Event("error"), { error: failure, message: failure.message, filename: "http://tauri.localhost/main.js" }));
  expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith("record_frontend_crash", {
    crash: { kind: "error", message: "error-proof", stack: failure.stack, url: "http://tauri.localhost/main.js" },
  });
});

it("does not issue native commands in a browser-only preview", async () => {
  browser = Object.assign(new EventTarget(), { location: { href: "http://localhost/" } });
  vi.stubGlobal("window", browser);
  (await import("./runtime-crash")).installRuntimeCrashCapture();
  browser.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("preview") }));
  expect(boundary.invoke).not.toHaveBeenCalled();
});

it("handles crash-report transport failure without another rejected promise", async () => {
  boundary.invoke.mockRejectedValue(new Error("transport unavailable"));
  (await import("./runtime-crash")).installRuntimeCrashCapture();
  browser.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "original-rejection" }));
  await Promise.resolve();
  await Promise.resolve();
  expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith("record_frontend_crash", {
    crash: { kind: "unhandledRejection", message: "original-rejection", url: "http://tauri.localhost/" },
  });
});

it("does not recursively inspect cyclic objects or throwing reason properties", async () => {
  (await import("./runtime-crash")).installRuntimeCrashCapture();
  const reason = { get message(): string { throw new Error("unsafe getter"); } };
  browser.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
  expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith("record_frontend_crash", {
    crash: { kind: "unhandledRejection", message: "Unhandled promise rejection (object)", url: "http://tauri.localhost/" },
  });
});

it("bounds large Unicode messages without creating unpaired surrogates", async () => {
  (await import("./runtime-crash")).installRuntimeCrashCapture();
  browser.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "\uD83D\uDE00".repeat(20_000) }));
  const message: string = boundary.invoke.mock.calls[0][1].crash.message;
  expect(message.length).toBeLessThanOrEqual(16_384);
  expect(message.endsWith("[truncated]")).toBe(true);
  expect(message).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});
