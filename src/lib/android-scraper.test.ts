import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: () => true,
}));

import { androidScraperNavigate } from "./android-scraper";

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

interface NavigatePayload {
  id: string;
  resetHistory: boolean;
  timeoutMs: number;
  url: string;
  userAgent: string | null;
}

function installScraperBridge() {
  const navigate = vi.fn();
  const cancel = vi.fn();
  vi.stubGlobal("window", {
    __NoreaAndroidScraper: {
      cancel,
      extract: vi.fn(),
      fetch: vi.fn(),
      hide: vi.fn(),
      navigate,
      setBounds: vi.fn(),
    },
    clearTimeout: nativeClearTimeout,
    setTimeout: nativeSetTimeout,
  });
  return { cancel, navigate };
}

function navigatePayload(navigate: ReturnType<typeof vi.fn>): NavigatePayload {
  return JSON.parse(navigate.mock.calls[0][0] as string) as NavigatePayload;
}

describe("Android scraper navigation", () => {
  beforeEach(() => {
    installScraperBridge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for the native page-finished result", async () => {
    const navigate = vi.mocked(window.__NoreaAndroidScraper!.navigate);
    let settled = false;
    const navigation = androidScraperNavigate(
      "https://example.com/chapter",
      "Norea/Test",
      { resetHistory: true, timeoutMs: 12_000 },
    ).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();

    expect(settled).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
    const payload = navigatePayload(navigate);
    expect(payload).toMatchObject({
      resetHistory: true,
      timeoutMs: 12_000,
      url: "https://example.com/chapter",
      userAgent: "Norea/Test",
    });

    window.__lnrAndroidScraperResolve?.(
      payload.id,
      JSON.stringify({ ok: true, result: true }),
    );

    await expect(navigation).resolves.toBe(true);
  });

  it("cancels the native navigation when its signal is aborted", async () => {
    const bridge = window.__NoreaAndroidScraper!;
    const navigate = vi.mocked(bridge.navigate);
    const cancel = vi.mocked(bridge.cancel!);
    const controller = new AbortController();
    const navigation = androidScraperNavigate(
      "https://example.com/chapter",
      null,
      { signal: controller.signal },
    );
    const rejection = expect(navigation).rejects.toMatchObject({
      name: "AbortError",
    });
    const payload = navigatePayload(navigate);

    controller.abort();

    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cancel.mock.calls[0][0] as string)).toMatchObject({
      id: payload.id,
    });
  });
});
