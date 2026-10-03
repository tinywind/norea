import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../tauri-runtime", () => ({ isAndroidRuntime: () => false }));

import { invoke } from "@tauri-apps/api/core";
import { runWithScraperExecutor } from "../tasks/scraper-queue";
import { pluginFetch } from "./plugin-fetch";
import { cancelScraperExecutor, desktopWebviewFetch } from "./scraper-transport";
import type { FetchResultWire, PluginFetchPriority } from "./types";

const invokeMock = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(url: string): FetchResultWire {
  return { status: 200, statusText: "OK", headers: {}, body: url, finalUrl: url };
}

function fetchRequest(
  url: string,
  options: {
    priority?: PluginFetchPriority;
    signal?: AbortSignal;
    scraperExecutor?: "immediate" | "pool:0";
  } = {},
) {
  return desktopWebviewFetch({
    url,
    init: {},
    contextUrl: "https://source.test/",
    sourceId: "source",
    userAgent: null,
    scraperExecutor: "immediate",
    timeoutMs: 30_000,
    signal: undefined,
    ...options,
  });
}

function fetchUrls(): string[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === "webview_fetch")
    .map(([, args]) => (args as { url: string }).url);
}

beforeEach(() => {
  invokeMock.mockReset().mockImplementation(async (command, args) => {
    return command === "webview_fetch"
      ? response((args as { url: string }).url)
      : true;
  });
});

describe("desktop scraper fetch admission", () => {
  it("preserves executor ownership when network cancellation wraps the task signal", async () => {
    const controller = new AbortController();
    await runWithScraperExecutor("source", "network-owned", "immediate", controller.signal, () =>
      pluginFetch("https://source.test/owned", { sourceId: "source", priority: "deferred" }));
    expect(fetchUrls()).toEqual(["https://source.test/owned"]);
  });
  it("preserves plugin fetch priority at the desktop boundary", async () => {
    const active = deferred<FetchResultWire>();
    invokeMock.mockImplementationOnce(() => active.promise);
    const first = fetchRequest("active-cover", { priority: "deferred" });
    const cover = pluginFetch("https://source.test/cover", {
      priority: "deferred",
    });
    const novel = pluginFetch("https://source.test/novel");
    await Promise.resolve();
    active.resolve(response("active-cover"));
    await Promise.all([first, cover, novel]);
    expect(fetchUrls()).toEqual([
      "active-cover",
      "https://source.test/novel",
      "https://source.test/cover",
    ]);
  });

  it("runs novel requests ahead of queued covers and keeps equal priorities FIFO", async () => {
    const active = deferred<FetchResultWire>();
    invokeMock.mockImplementationOnce(() => active.promise);
    const first = fetchRequest("active-cover", { priority: "deferred" });
    const covers = ["cover-1", "cover-2"].map((url) =>
      fetchRequest(url, { priority: "deferred" }),
    );
    const novel = fetchRequest("novel");

    expect(fetchUrls()).toEqual(["active-cover"]);
    active.resolve(response("active-cover"));
    await Promise.all([first, ...covers, novel]);
    expect(fetchUrls()).toEqual(["active-cover", "novel", "cover-1", "cover-2"]);
  });

  it("reserves the executor across sequential novel pages and resumes independent covers afterward", async () => {
    const controller = new AbortController();
    const betweenPages = deferred<void>();
    let cover!: Promise<FetchResultWire>;
    const task = runWithScraperExecutor(
      "source",
      "open-novel",
      "immediate",
      controller.signal,
      async () => {
        cover = fetchRequest("cover", {
          priority: "deferred",
          signal: new AbortController().signal,
        });
        await fetchRequest("page-1", { signal: controller.signal });
        await betweenPages.promise;
        await fetchRequest("page-2", { signal: controller.signal });
      },
    );

    await vi.waitFor(() => expect(fetchUrls()).toEqual(["page-1"]));
    betweenPages.resolve();
    await task;
    await cover;
    expect(fetchUrls()).toEqual(["page-1", "page-2", "cover"]);
  });

  it("allows a deferred fetch owned by the running task", async () => {
    const controller = new AbortController();
    await runWithScraperExecutor(
      "source",
      "owned",
      "immediate",
      controller.signal,
      async () => {
        await fetchRequest("owned-cover", {
          priority: "deferred",
          signal: controller.signal,
        });
      },
    );
    expect(fetchUrls()).toEqual(["owned-cover"]);
  });

  it("runs independent executors concurrently", async () => {
    const active = deferred<FetchResultWire>();
    invokeMock.mockImplementationOnce(() => active.promise);
    const immediate = fetchRequest("immediate");
    await fetchRequest("pool", { scraperExecutor: "pool:0" });
    expect(fetchUrls()).toEqual(["immediate", "pool"]);
    active.resolve(response("immediate"));
    await immediate;
  });

  it("removes an aborted queued request without cancelling active native work", async () => {
    const active = deferred<FetchResultWire>();
    invokeMock.mockImplementationOnce(() => active.promise);
    const first = fetchRequest("active");
    const controller = new AbortController();
    const queued = fetchRequest("queued", { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "webview_fetch",
    ]);
    active.resolve(response("active"));
    await first;
    expect(fetchUrls()).toEqual(["active"]);
  });

  it("holds admission until an aborted native request and cancellation have both settled", async () => {
    const active = deferred<FetchResultWire>();
    const cancellation = deferred<boolean>();
    invokeMock.mockImplementation((command, args) => {
      if (command === "scraper_cancel_executor") return cancellation.promise;
      if ((args as { url: string }).url === "active") return active.promise;
      return Promise.resolve(response((args as { url: string }).url));
    });
    const controller = new AbortController();
    const first = fetchRequest("active", { signal: controller.signal });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const next = fetchRequest("after-cancel");
    active.reject(new Error("native cancelled"));
    await Promise.resolve();
    expect(fetchUrls()).toEqual(["active"]);
    cancellation.resolve(true);
    await next;
    expect(fetchUrls()).toEqual(["active", "after-cancel"]);
  });

  it("drops pending requests on explicit executor cancellation and then recovers", async () => {
    const active = deferred<FetchResultWire>();
    invokeMock.mockImplementationOnce(() => active.promise);
    const first = fetchRequest("active");
    const queued = fetchRequest("queued", { priority: "deferred" });
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await cancelScraperExecutor("immediate");
    await rejected;
    active.resolve(response("active"));
    await first;
    await fetchRequest("recovered");
    expect(fetchUrls()).toEqual(["active", "recovered"]);
  });

  it("keeps an aborted native request active after the cancellation IPC completes", async () => {
    const active = deferred<FetchResultWire>();
    invokeMock.mockImplementationOnce(() => active.promise);
    const controller = new AbortController();
    const first = fetchRequest("active", { signal: controller.signal });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const next = fetchRequest("after-cancel");
    expect(fetchUrls()).toEqual(["active"]);
    active.reject(new Error("native cancelled"));
    await next;
    expect(fetchUrls()).toEqual(["active", "after-cancel"]);
  });

  it("continues after a failed native fetch", async () => {
    const active = deferred<FetchResultWire>();
    invokeMock.mockImplementationOnce(() => active.promise);
    const first = fetchRequest("failed");
    const rejected = expect(first).rejects.toThrow("network failed");
    const next = fetchRequest("next");
    active.reject(new Error("network failed"));
    await rejected;
    await next;
    expect(fetchUrls()).toEqual(["failed", "next"]);
  });
});
