import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  androidCloseVpnDownloadWorker,
  androidConfigureVpnDownloadWorker,
  androidEnsureVpnDownloadWorker,
  androidShowVpnDownloadWorker,
  androidWebviewExtract,
  androidWebviewFetch,
} from "./android-scraper";

vi.mock("./tauri-runtime", () => ({ isAndroidRuntime: () => true }));
const worker = { rangeId: "range-a", slot: 0, generation: 11 } as const;
let requests: Record<string, unknown>[];
let pausedExtraction: Record<string, unknown> | null;
let holdExtraction = false;
beforeEach(() => {
  requests = [];
  pausedExtraction = null;
  holdExtraction = false;
  let nonce = 0;
  const respond = (id: string, result: unknown) => window.__noreaAndroidScraperResolve?.(id, JSON.stringify({ ok: true, result }));
  vi.stubGlobal("window", {
    setTimeout, clearTimeout,
    __NoreaAndroidBridge: {
      session: () => JSON.stringify({ sessionToken: "session", capabilities: ["vpn.worker"] }),
      nonce: () => `nonce-value-${++nonce}`,
    },
    __NoreaAndroidScraper: {
      extract: (raw: string) => respond(JSON.parse(raw).id, "default route"),
      fetch: (raw: string) => respond(JSON.parse(raw).id, { body: "default route" }),
      cancel: () => { throw new Error("Wrong cancellation route"); },
    },
    __NoreaAndroidVpnWorkers: {
      request: (raw: string) => {
        const request = JSON.parse(raw);
        if (request._bridge.capability !== "vpn.worker" || request._bridge.sessionToken !== "session") throw new Error("Missing bridge authority");
        requests.push(request);
        if (request.method === "extract" && holdExtraction) { pausedExtraction = request; return; }
        if (request.method === "extract") respond(request.id, `worker ${request.queue}`);
        else if (request.method === "fetch") respond(request.id, { status: 200, statusText: "OK", headers: {}, body: `worker ${request.queue}`, finalUrl: request.url });
        else respond(request.id, true);
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Android VPN worker bridge routing", () => {
  it("checks the exact configured route before a budgeted retry can recreate a dead browser", async () => {
    await androidEnsureVpnDownloadWorker(worker, { sourceId: "source", profileId: "profile-a", proxyPort: 12345 });
    expect(requests[0]).toMatchObject({ method: "ensureWorker", slot: 0, generation: 11, sourceId: "source", profileId: "profile-a", proxyPort: 12345 });
  });
  it.each([2, 9] as const)("keeps slot %s configuration, bodies, assets and cleanup on the same isolated route", async slot => {
    const owner = { ...worker, slot };
    const queue = `vpn:${slot}:11` as const;
    await androidConfigureVpnDownloadWorker(owner, { sourceId: "source", profileId: `profile-${slot}`, proxyPort: 18080 + slot });
    await expect(androidWebviewExtract("https://source.test/chapter", "script", 1000, null, "source", queue)).resolves.toBe(`worker ${queue}`);
    await expect(androidWebviewFetch("https://source.test/image", {}, null, null, "source", queue, 1000)).resolves.toMatchObject({ body: `worker ${queue}` });
    await androidShowVpnDownloadWorker(owner, "source");
    await androidCloseVpnDownloadWorker(owner, "source");
    expect(requests.map(value => value.queue)).toEqual([queue, queue, queue, queue, queue]);
  });

  it("configures a worker and routes both extraction and source assets away from the default bridge", async () => {
    await androidConfigureVpnDownloadWorker(worker, { sourceId: "source", profileId: "profile-a", proxyPort: 12345 });
    expect(requests[0]).toMatchObject({ method: "configureWorker", slot: 0, generation: 11, sourceId: "source", profileId: "profile-a", proxyPort: 12345 });
    await expect(androidWebviewExtract("https://source.test/chapter", "script", 1000, null, "source", "vpn:0:11"))
      .resolves.toBe("worker vpn:0:11");
    await expect(androidWebviewFetch("https://source.test/image", {}, null, null, "source", "vpn:0:11", 1000))
      .resolves.toMatchObject({ body: "worker vpn:0:11" });
    await androidShowVpnDownloadWorker(worker, "source");
    await androidCloseVpnDownloadWorker(worker, "source");
    expect(requests.slice(-2).map(({ method, queue }) => [method, queue])).toEqual([["showWorker", "vpn:0:11"], ["closeWorker", "vpn:0:11"]]);
  });

  it("cancels the owning remote request without cancelling a default source WebView", async () => {
    holdExtraction = true;
    const controller = new AbortController();
    const extraction = androidWebviewExtract("https://source.test/chapter", "script", 1000, null, "source", "vpn:0:11", controller.signal);
    controller.abort();
    await expect(extraction).rejects.toMatchObject({ name: "AbortError" });
    expect(requests.at(-1)).toMatchObject({ method: "cancel", id: pausedExtraction!.id, queue: "vpn:0:11", sourceId: "source" });
  });

  it("fails closed when the remote worker bridge is unavailable", async () => {
    delete window.__NoreaAndroidVpnWorkers;
    await expect(androidWebviewExtract("https://source.test/chapter", null, 1000, null, "source", "vpn:0:11"))
      .rejects.toThrow(/worker/i);
  });

  it("rejects malformed physical slots, generations and proxy ports before sending native configuration", async () => {
    for (const slot of [-1, 10, 0.5]) {
      await expect(androidConfigureVpnDownloadWorker({ ...worker, slot } as never, { sourceId: "source", profileId: "profile", proxyPort: 12345 })).rejects.toThrow(/worker/i);
    }
    await expect(androidConfigureVpnDownloadWorker({ ...worker, generation: 0 }, { sourceId: "source", profileId: "profile", proxyPort: 12345 })).rejects.toThrow(/worker/i);
    await expect(androidConfigureVpnDownloadWorker(worker, { sourceId: "source", profileId: "profile", proxyPort: 0 })).rejects.toThrow(/port/i);
    expect(requests).toEqual([]);
  });
});
