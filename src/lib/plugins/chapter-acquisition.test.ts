import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./shims", () => ({
  captureChapterWebView: vi.fn(),
}));

import { captureChapterWebView } from "./shims";
import {
  captureChapterPage,
  validateChapterAcquisitionPlan,
} from "./chapter-acquisition";
import { isSourceAccessRequiredError } from "./source-access";

const mockedCaptureChapterWebView = vi.mocked(captureChapterWebView);

interface CaptureElement {
  complete: boolean;
  currentSrc: string;
  getAttribute: (name: string) => string | null;
  removeAttribute: (name: string) => void;
  setAttribute: (name: string, value: string) => void;
  tagName: string;
}

function captureImage(
  attributes: Record<string, string>,
  complete = true,
): {
  attributes: Map<string, string>;
  element: CaptureElement;
} {
  const values = new Map(Object.entries(attributes));
  return {
    attributes: values,
    element: {
      complete,
      currentSrc: "",
      getAttribute: (name) => values.get(name) ?? null,
      removeAttribute: (name) => values.delete(name),
      setAttribute: (name, value) => values.set(name, value),
      tagName: "IMG",
    },
  };
}

function executeChapterCaptureScript(
  script: string,
  {
    manualAction,
    settleImageAfterFirstPoll = false,
  }: {
    manualAction?: "captcha" | "cloudflare" | "legacy";
    settleImageAfterFirstPoll?: boolean;
  } = {},
): { message: string; postedBeforeImageSettled: boolean } {
  const sourceImage = captureImage({
    "data-src": "/assets/page.jpg?accessKey=asset",
  }, !settleImageAfterFirstPoll);
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
    querySelectorAll: (selector: string) => {
      if (selector === "img") return [clonedImage.element];
      if (selector === "*") return [clonedImage.element];
      return [];
    },
    tagName: "ARTICLE",
  };
  const sourceRoot = {
    cloneNode: () => {
      clonedImage.attributes.clear();
      for (const [name, value] of sourceImage.attributes) {
        clonedImage.attributes.set(name, value);
      }
      return cloneRoot;
    },
    querySelectorAll: (selector: string) => {
      if (selector === "img") return [sourceImage.element];
      if (selector !== "*") return [];
      return [sourceImage.element];
    },
    tagName: "ARTICLE",
  };
  let postedMessage: string | undefined;
  const scheduledCallbacks: Array<() => void> = [];

  runInNewContext(script, {
    URL,
    document: {
      querySelector: (selector: string) => {
        if (selector !== "[data-norea-manual-action]") return sourceRoot;
        if (!manualAction) return null;
        return {
          getAttribute: (name: string) =>
            name === "data-norea-manual-action"
              ? manualAction === "legacy"
                ? ""
                : manualAction
              : null,
        };
      },
      readyState: "complete",
    },
    location: { href: "https://source.test/chapter/1" },
    setTimeout: (callback: () => void) => {
      scheduledCallbacks.push(callback);
    },
    window: {
      ReactNativeWebView: {
        postMessage: (message: string) => {
          postedMessage = message;
        },
      },
    },
  });

  const postedBeforeImageSettled = postedMessage !== undefined;
  if (settleImageAfterFirstPoll) {
    sourceImage.element.complete = true;
    while (!postedMessage && scheduledCallbacks.length > 0) {
      scheduledCallbacks.shift()?.();
    }
  }
  if (!postedMessage) throw new Error("Capture script did not post a result.");
  return { message: postedMessage, postedBeforeImageSettled };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it("rejects a non-boolean cacheBust value", () => {
    expect(() =>
      validateChapterAcquisitionPlan({
        type: "page",
        url: "https://source.test/chapter/1",
        contentSelector: "body",
        cacheBust: "true",
      }),
    ).toThrow("cacheBust must be a boolean");
  });
});

describe("captureChapterPage", () => {
  it("loads a lazy-only image in the WebView before capture", async () => {
    let postedBeforeImageSettled = true;
    mockedCaptureChapterWebView.mockImplementationOnce(async (_url, options) => {
      if (!options?.beforeContentScript) {
        throw new Error("Expected chapter capture script.");
      }
      const execution = executeChapterCaptureScript(options.beforeContentScript, {
        settleImageAfterFirstPoll: true,
      });
      postedBeforeImageSettled = execution.postedBeforeImageSettled;
      return execution.message;
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

    expect(postedBeforeImageSettled).toBe(false);
    expect(result.content).toBe(
      '<img data-src="https://source.test/assets/page.jpg?accessKey=asset" loading="eager" src="https://source.test/assets/page.jpg?accessKey=asset">',
    );
  });

  it("adds distinct cache busters without discarding source query values", async () => {
    const sourceUrl =
      "https://source.test/chapter/1?signature=a%20b~c&token=one&token=two&_norea_capture=source#reader";
    mockedCaptureChapterWebView.mockImplementation(async navigationUrl =>
      JSON.stringify({
        ok: true,
        result: {
          content: '<img src="https://cdn.test/page.jpg?accessKey=asset">',
          url: navigationUrl,
        },
      }),
    );
    const plan = validateChapterAcquisitionPlan({
      type: "page",
      url: sourceUrl,
      contentSelector: "[data-norea-chapter-content]",
      documentStartScript: "window.prepareChapter();",
      cacheBust: true,
    });
    if (plan.type !== "page") throw new Error("Expected page plan.");

    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const firstResult = await captureChapterPage(plan, {
      contentType: "html",
      executor: "pool:1",
      sourceId: "source-a",
    });
    const secondResult = await captureChapterPage(plan, {
      contentType: "html",
      executor: "pool:1",
      sourceId: "source-a",
    });
    const [firstNavigationUrl, options] =
      mockedCaptureChapterWebView.mock.calls[0]!;
    const [secondNavigationUrl] = mockedCaptureChapterWebView.mock.calls[1]!;
    if (!options) throw new Error("Expected WebView fetch options.");
    const firstNonce = firstNavigationUrl.match(
      /&_norea_capture=([^&#]+)#reader$/,
    )?.[1];
    const secondNonce = secondNavigationUrl.match(
      /&_norea_capture=([^&#]+)#reader$/,
    )?.[1];
    expect(
      firstNavigationUrl.replace(/&_norea_capture=[^&#]+(?=#)/, ""),
    ).toBe(sourceUrl);
    expect(
      secondNavigationUrl.replace(/&_norea_capture=[^&#]+(?=#)/, ""),
    ).toBe(sourceUrl);
    expect(firstNavigationUrl).toContain(
      "?signature=a%20b~c&token=one&token=two&_norea_capture=source&_norea_capture=",
    );
    expect(firstNonce).toMatch(/^rs-[0-9a-z]+$/);
    expect(secondNonce).toMatch(/^rs-[0-9a-z]+$/);
    expect(firstNonce).not.toBe(secondNonce);
    expect(firstNavigationUrl).not.toBe(secondNavigationUrl);
    expect(options.beforeContentScript).toContain("window.prepareChapter();");
    expect(options.scraperExecutor).toBe("pool:1");
    expect(options).not.toHaveProperty("pageCachePolicy");
    expect(firstResult).toEqual({
      baseUrl: sourceUrl,
      content: '<img src="https://cdn.test/page.jpg?accessKey=asset">',
    });
    expect(secondResult.baseUrl).toBe(sourceUrl);
  });

  it("removes only the host cache buster after a redirect", async () => {
    mockedCaptureChapterWebView.mockImplementationOnce(async navigationUrl => {
      const hostNonce = navigationUrl.match(
        /[?&]_norea_capture=([^&#]+)/,
      )?.[1];
      if (!hostNonce) throw new Error("Expected host cache buster.");
      return JSON.stringify({
        ok: true,
        result: {
          content: "<p>Redirected chapter</p>",
          url: `https://redirect.test/final?_norea_capture=source&signature=a%20b~c&_norea_capture=${hostNonce}&token=one&token=two#reader`,
        },
      });
    });
    const plan = validateChapterAcquisitionPlan({
      type: "page",
      url: "https://source.test/chapter/redirected",
      contentSelector: "article",
      cacheBust: true,
    });
    if (plan.type !== "page") throw new Error("Expected page plan.");

    const result = await captureChapterPage(plan, {
      contentType: "html",
      executor: "pool:1",
      sourceId: "source-a",
    });

    expect(result.baseUrl).toBe(
      "https://redirect.test/final?_norea_capture=source&signature=a%20b~c&token=one&token=two#reader",
    );
  });

  it("surfaces stable capture error codes", async () => {
    mockedCaptureChapterWebView.mockResolvedValueOnce(
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

  it("turns a CAPTCHA marker into a typed source access error", async () => {
    mockedCaptureChapterWebView.mockImplementationOnce(async (_url, options) => {
      if (!options?.beforeContentScript) {
        throw new Error("Expected chapter capture script.");
      }
      return executeChapterCaptureScript(options.beforeContentScript, {
        manualAction: "captcha",
      }).message;
    });
    const plan = validateChapterAcquisitionPlan({
      type: "page",
      url: "https://source.test/chapter/1",
      contentSelector: "article",
      loadStrategy: "selector",
    });
    if (plan.type !== "page") throw new Error("Expected page plan.");

    const promise = captureChapterPage(plan, {
      contentType: "html",
      executor: "immediate",
      sourceId: "source-a",
    });

    await expect(promise).rejects.toSatisfy(
      (error: unknown) =>
        isSourceAccessRequiredError(error) &&
        error.challenge.kind === "captcha" &&
        error.challenge.url === "https://source.test/chapter/1",
    );
  });
});
