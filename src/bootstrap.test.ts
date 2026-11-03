import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ invoke: vi.fn(), start: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: boundary.invoke }));
let root: { textContent: string; setAttribute: ReturnType<typeof vi.fn> };

async function loadEntry(): Promise<void> {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const source = html.match(/<script type="module" src="\/src\/([^\"]+)"/)!;
  const entry = `./${source[1]}`;
  await import(/* @vite-ignore */ entry);
}

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.doMock("./main.tsx", () => { boundary.start(); return {}; });
  root = { textContent: "", setAttribute: vi.fn() };
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("navigator", { language: "en" });
  vi.stubGlobal("document", { getElementById: () => root });
  boundary.invoke.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

it("does not load application modules until native restore completion is confirmed", async () => {
  let confirm!: () => void;
  boundary.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { confirm = resolve; }));
  await loadEntry();
  expect(boundary.start).not.toHaveBeenCalled();
  expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith("device_backup_restore_check");
  confirm();
  await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledOnce());
});

it.each(["Interrupted restore checkpoint", "Restore completion could not be read"])("blocks app startup without deleting recovery data on %s", async error => {
  boundary.invoke.mockRejectedValueOnce(error);
  await loadEntry();
  await vi.waitFor(() => expect(root.textContent).toContain(error));
  expect(boundary.start).not.toHaveBeenCalled();
  expect(root.setAttribute).toHaveBeenCalledWith("role", "alert");
  expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith("device_backup_restore_check");
});

it("starts the browser-only preview without requiring native IPC", async () => {
  vi.stubGlobal("window", {});
  await loadEntry();
  await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledOnce());
  expect(boundary.invoke).not.toHaveBeenCalled();
});

it.each(["error", "unhandledRejection"] as const)("captures %s while the restore fence is still pending", async kind => {
  const browser = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {},
    location: { href: "http://tauri.localhost/" },
  });
  vi.stubGlobal("window", browser);
  let confirm!: () => void;
  boundary.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { confirm = resolve; }));
  await loadEntry();
  const failure = new Error("early-crash-proof");
  const event = Object.assign(new Event(kind === "error" ? "error" : "unhandledrejection"),
    kind === "error" ? { error: failure, message: failure.message, filename: "http://tauri.localhost/bootstrap.js" } : { reason: failure });
  browser.dispatchEvent(event);
  await vi.waitFor(() => expect(boundary.invoke).toHaveBeenCalledWith("record_frontend_crash", {
    crash: {
      kind,
      message: "early-crash-proof",
      stack: failure.stack,
      url: kind === "error" ? "http://tauri.localhost/bootstrap.js" : "http://tauri.localhost/",
    },
  }));
  expect(boundary.start).not.toHaveBeenCalled();
  confirm();
  await vi.waitFor(() => expect(boundary.start).toHaveBeenCalledOnce());
});
