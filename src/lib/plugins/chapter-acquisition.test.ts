import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./shims", () => ({
  webViewFetch: vi.fn(),
}));

import { webViewFetch } from "./shims";
import {
  captureChapterPage,
  validateChapterAcquisitionPlan,
} from "./chapter-acquisition";

const mockedWebViewFetch = vi.mocked(webViewFetch);

interface CaptureElement {
  currentSrc: string;
  getAttribute: (name: string) => string | null;
  removeAttribute: (name: string) => void;
  setAttribute: (name: string, value: string) => void;
  tagName: string;
}

function captureImage(attributes: Record<string, string>): {
  attributes: Map<string, string>;
  element: CaptureElement;
} {
  const values = new Map(Object.entries(attributes));
  return {
    attributes: values,
    element: {
      currentSrc: "",
      getAttribute: (name) => values.get(name) ?? null,
      removeAttribute: (name) => values.delete(name),
      setAttribute: (name, value) => values.set(name, value),
      tagName: "IMG",
    },
  };
}

function executeChapterCaptureScript(script: string): string {
  const sourceImage = captureImage({
    "data-src": "/assets/page.jpg?accessKey=asset",
  });
  const clonedImage = captureImage(
    Object.fromEntries(sourceImage.attributes.entries()),
  );
  const cloneRoot = {
    get innerHTML() {
      const attributes = [...clonedImage.attributes.entries()]
        .map(([name, value]) => ` ${name}="${value}"`)
        .join("");
      return `<img${attributes}>`;
    },
    querySelectorAll: (selector: string) =>
      selector === "*" ? [clonedImage.element] : [],
    tagName: "ARTICLE",
  };
  const sourceRoot = {
    cloneNode: () => cloneRoot,
    querySelectorAll: (selector: string) =>
      selector === "*" ? [sourceImage.element] : [],
    tagName: "ARTICLE",
  };
  let postedMessage: string | undefined;

  runInNewContext(script, {
    URL,
    document: {
      querySelector: (selector: string) =>
        selector === "[data-norea-manual-action]" ? null : sourceRoot,
      readyState: "complete",
    },
    location: { href: "https://source.test/chapter/1" },
    setTimeout: vi.fn(),
    window: {
      ReactNativeWebView: {
        postMessage: (message: string) => {
          postedMessage = message;
        },
      },
    },
  });

  if (!postedMessage) throw new Error("Capture script did not post a result.");
  return postedMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateChapterAcquisitionPlan", () => {
  it("accepts explicit resources without page fields", () => {
    expect(validateChapterAcquisitionPlan({ type: "resource" })).toEqual({
      type: "resource",
    });
  });

  it("normalizes page defaults and clamps the timeout", () => {
    expect(
      validateChapterAcquisitionPlan({
        type: "page",
        url: "https://source.test/chapter/1?accessKey=signed",
        contentSelector: " article.chapter ",
        timeoutMs: 500_000,
      }),
    ).toEqual({
      type: "page",
      url: "https://source.test/chapter/1?accessKey=signed",
      contentSelector: "article.chapter",
      loadStrategy: "network-idle",
      cacheBust: false,
      timeoutMs: 120_000,
    });
  });

  it("rejects non-HTTP page URLs", () => {
    expect(() =>
      validateChapterAcquisitionPlan({
        type: "page",
        url: "file:///chapter.html",
        contentSelector: "body",
      }),
    ).toThrow("HTTP or HTTPS");
  });
});

describe("captureChapterPage", () => {
  it("keeps a lazy-only image URL inert while making it absolute", async () => {
    mockedWebViewFetch.mockImplementationOnce(async (_url, options) => {
      if (!options?.beforeContentScript) {
        throw new Error("Expected chapter capture script.");
      }
      return executeChapterCaptureScript(options.beforeContentScript);
    });
    const plan = validateChapterAcquisitionPlan({
      type: "page",
      url: "https://source.test/chapter/1",
      contentSelector: "article",
      loadStrategy: "selector",
    });
    if (plan.type !== "page") throw new Error("Expected page plan.");

    const result = await captureChapterPage(plan, {
      contentType: "html",
      executor: "immediate",
      sourceId: "source-a",
    });

    expect(result.content).toBe(
      '<img data-src="https://source.test/assets/page.jpg?accessKey=asset">',
    );
    expect(result.content).not.toContain(" src=");
  });

  it("preserves signed query values when adding the host cache buster", async () => {
    mockedWebViewFetch.mockResolvedValueOnce(
      JSON.stringify({
        ok: true,
        result: {
          content: '<img src="https://cdn.test/page.jpg?accessKey=asset">',
          url: "https://source.test/chapter/1?accessKey=signed",
        },
      }),
    );
    const plan = validateChapterAcquisitionPlan({
      type: "page",
      url: "https://source.test/chapter/1?accessKey=signed",
      contentSelector: "[data-norea-chapter-content]",
      documentStartScript: "window.prepareChapter();",
      cacheBust: true,
    });
    if (plan.type !== "page") throw new Error("Expected page plan.");

    const result = await captureChapterPage(plan, {
      contentType: "html",
      executor: "pool:1",
      sourceId: "source-a",
    });

    const [navigationUrl, options] = mockedWebViewFetch.mock.calls[0]!;
    if (!options) throw new Error("Expected WebView fetch options.");
    const url = new URL(navigationUrl);
    expect(url.searchParams.get("accessKey")).toBe("signed");
    expect(url.searchParams.get("_norea_capture")).toBeTruthy();
    expect(options.beforeContentScript).toContain("window.prepareChapter();");
    expect(options.scraperExecutor).toBe("pool:1");
    expect(result).toEqual({
      baseUrl: "https://source.test/chapter/1?accessKey=signed",
      content: '<img src="https://cdn.test/page.jpg?accessKey=asset">',
    });
  });

  it("surfaces stable capture error codes", async () => {
    mockedWebViewFetch.mockResolvedValueOnce(
      JSON.stringify({
        ok: false,
        code: "manual-action-required",
        error: "The source page requires manual action.",
      }),
    );
    const plan = validateChapterAcquisitionPlan({
      type: "page",
      url: "https://source.test/chapter/paid",
      contentSelector: "article",
    });
    if (plan.type !== "page") throw new Error("Expected page plan.");

    await expect(
      captureChapterPage(plan, {
        contentType: "html",
        executor: "immediate",
        sourceId: "source-a",
      }),
    ).rejects.toThrow("manual-action-required");
  });
});
