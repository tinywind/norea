import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(() => false),
  isWindowsRuntime: vi.fn(() => true),
}));

import { invoke } from "@tauri-apps/api/core";
import { usePluginVpnStore } from "../../store/plugin-vpn";
import { useNetworkStore } from "../network";
import { isAndroidRuntime, isWindowsRuntime } from "../tauri-runtime";
import { TaskScheduler } from "../tasks/scheduler";
import { pluginFetch } from "./plugin-fetch";
import type { FetchResultWire } from "./types";

function response(url: string): FetchResultWire {
  return { status: 200, statusText: "OK", headers: {}, body: "source response", finalUrl: url };
}

beforeEach(() => {
  vi.useFakeTimers();
  usePluginVpnStore.getState().setEnabled(false);
  useNetworkStore.setState({ connectivity: "online", revision: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("source UI transport isolation", () => {
  it.each([
    ["Windows", "source.refreshNovel", "immediate"],
    ["Android", "source.refreshNovel", "immediate"],
    ["Windows", "source.globalSearch", "search:0"],
    ["Android", "source.globalSearch", "search:0"],
  ] as const)("sends %s %s while a download remains in flight", async (platform, kind, executor) => {
    const android = platform === "Android";
    vi.mocked(isAndroidRuntime).mockReturnValue(android);
    vi.mocked(isWindowsRuntime).mockReturnValue(!android);
    const scheduler = new TaskScheduler({ sourceForegroundConcurrency: 1, sourceQueuesPaused: false });
    const source = { id: "source", name: "Source" };
    const requests: { url: string; queue: string }[] = [];
    const downloadUrl = "https://source.test/chapter";
    const uiUrl = "https://source.test/novel";
    let releaseDownload!: () => void;

    vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
      if (command !== "webview_fetch") throw new Error(`Unexpected native command: ${command}`);
      const payload = args as { url: string; queue: string };
      requests.push({ url: payload.url, queue: payload.queue });
      if (payload.url === downloadUrl) {
        return new Promise<FetchResultWire>(resolve => { releaseDownload = () => resolve(response(payload.url)); });
      }
      return response(payload.url);
    });
    if (android) {
      vi.stubGlobal("window", {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        __NoreaAndroidScraper: {
          fetch(raw: string) {
            const payload = JSON.parse(raw) as { id: string; url: string; queue: string };
            requests.push({ url: payload.url, queue: payload.queue });
            const finish = () => window.__noreaAndroidScraperResolve?.(
              payload.id, JSON.stringify({ ok: true, result: response(payload.url) }),
            );
            if (payload.url === downloadUrl) releaseDownload = finish;
            else finish();
          },
        },
      });
    }

    const download = scheduler.enqueueSource({
      kind: "chapter.download", title: "Download", priority: "background", source,
      run: async context => {
        const result = await pluginFetch(downloadUrl, { sourceId: source.id, scraperExecutor: context.executor, signal: context.signal });
        return result.text();
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual([{ url: downloadUrl, queue: "pool:0" }]);
    const ui = scheduler.enqueueSource({
      kind, title: "Refresh novel", priority: "user", source,
      run: async context => {
        const result = await pluginFetch(uiUrl, { sourceId: source.id, scraperExecutor: context.executor, signal: context.signal });
        return result.text();
      },
    });
    void ui.promise.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toEqual([
        { url: downloadUrl, queue: "pool:0" },
        { url: uiUrl, queue: executor },
      ]);
      await expect(ui.promise).resolves.toBe("source response");
      expect(scheduler.getTask(download.id)?.status).toBe("running");
    } finally {
      releaseDownload();
      await download.promise;
      scheduler.cancelActiveTasks({ discardQueued: true });
      await vi.advanceTimersByTimeAsync(0);
    }
  });
});
