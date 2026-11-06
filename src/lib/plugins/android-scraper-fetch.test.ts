import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const template = readFileSync(
  "src-tauri/gen/android/app/src/main/res/raw/norea_scraper_fetch.js",
  "utf8",
);

describe("Android scraper fetch after a VPN route change", () => {
  it.each([true, false])("uses cache bypass %s without losing browser credentials or adding requests", async bypassCache => {
    const fetch = vi.fn(async () => new Response("chapter", { status: 200 }));
    const post = vi.fn();
    const script = template
      .replaceAll("__NOREA_REQUEST_JSON__", JSON.stringify({ url: "https://source.test/chapter", init: {} }))
      .replaceAll("__NOREA_REQUEST_ID_JSON__", JSON.stringify("fetch-1"))
      .replaceAll("__NOREA_REQUEST_NONCE_JSON__", JSON.stringify("nonce-1"))
      .replaceAll("__NOREA_BYPASS_CACHE__", String(bypassCache));
    runInNewContext(script, {
      window: {}, fetch, Headers, AbortController, Uint8Array, btoa, setTimeout,
      AndroidScraper: { postFetchResultWithNonce: post },
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://source.test/chapter", expect.objectContaining({
      cache: bypassCache ? "reload" : "default",
      credentials: "include",
      redirect: "follow",
    }));
  });
});
