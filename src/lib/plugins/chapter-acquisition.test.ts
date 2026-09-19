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

interface InteractiveCapturePage {
  buttonPresent?: boolean;
  manualActionAfterClick?: boolean;
}

function executeInteractiveCaptureScript(
  script: string,
  page: InteractiveCapturePage = {},
): { clicks: number; elapsedMs: number; message: string } {
  const timers: Array<{ at: number; callback: () => void }> = [];
  let now = 0;
  let clicks = 0;
  let revealed = false;
  let postedMessage: string | undefined;
  const clone = { innerHTML: "<p>Full chapter</p>", querySelectorAll: () => [] };
  const root = {
    cloneNode: () => clone,
    querySelectorAll: () => [],
    tagName: "ARTICLE",
  };
  const button = {
    click() {
      clicks += 1;
      revealed = true;
    },
    dispatchEvent: () => true,
    focus() {},
    getBoundingClientRect: () => ({ height: 10, left: 0, top: 0, width: 10 }),
    scrollIntoView() {},
    tagName: "BUTTON",
  };

  runInNewContext(script, {
    Date: { now: () => now },
    Event: class {
      constructor(
        readonly type: string,
        readonly init: Record<string, unknown> = {},
      ) {}
    },
    URL,
    document: {
      querySelector: (selector: string) => {
        if (selector === "[data-norea-manual-action]") {
          return page.manualActionAfterClick && clicks > 0
            ? { getAttribute: () => "captcha" }
            : null;
        }
        if (selector === "button.more") {
          return page.buttonPresent === false ? null : button;
        }
        if (selector === "article") return revealed ? root : null;
        return null;
      },
      readyState: "complete",
    },
    location: { href: "https://source.test/chapter/1" },
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ at: now + delay, callback });
    },
    window: {
      ReactNativeWebView: {
        postMessage: (message: string) => {
          postedMessage = message;
        },
      },
    },
  });
  while (!postedMessage && timers.length > 0) {
    timers.sort((left, right) => left.at - right.at);
    const next = timers.shift()!;
    now = Math.max(now, next.at);
    next.callback();
  }
  if (!postedMessage) throw new Error("Capture script did not post a result.");
  return { clicks, elapsedMs: now, message: postedMessage };
}

describe("chapter page interactions", () => {
  it("normalizes plan interactions", () => {
    const plan = validateChapterAcquisitionPlan({
      type: "page",
      url: "https://source.test/chapter/1",
      contentSelector: "article",
      interactions: [{ type: "click", selector: " button.more ", timeoutMs: 50 }],
    });
    if (plan.type !== "page") throw new Error("Expected page plan.");
    expect(plan.interactions).toEqual([
      { type: "click", selector: "button.more", timeoutMs: 100 },
    ]);

    const withoutSteps = validateChapterAcquisitionPlan({
      type: "page",
      url: "https://source.test/chapter/1",
      contentSelector: "article",
      interactions: [],
    });
    expect(withoutSteps).not.toHaveProperty("interactions");

    expect(() =>
      validateChapterAcquisitionPlan({
        type: "page",
        url: "https://source.test/chapter/1",
        contentSelector: "article",
        interactions: [{ type: "click", selector: "" }],
      }),
    ).toThrow(
      "Chapter acquisition interactions[0].selector must be a non-empty selector.",
    );
  });

  it("performs interactions before waiting for the content selector", async () => {
    let clicks = 0;
    mockedCaptureChapterWebView.mockImplementationOnce(async (_url, options) => {
      const execution = executeInteractiveCaptureScript(
        options?.beforeContentScript ?? "",
      );
      clicks = execution.clicks;
      return execution.message;
    });
    const plan = validateChapterAcquisitionPlan({
      type: "page",
      url: "https://source.test/chapter/1",
      contentSelector: "article",
      interactions: [{ type: "click", selector: "button.more" }],
      loadStrategy: "selector",
    });
    if (plan.type !== "page") throw new Error("Expected page plan.");

    const result = await captureChapterPage(plan, {
      contentType: "html",
      executor: "immediate",
      sourceId: "source-a",
    });

    expect(clicks).toBe(1);
    expect(result.content).toBe("<p>Full chapter</p>");
  });

  it("fails with interaction-failed when a required target never appears", async () => {
    mockedCaptureChapterWebView.mockImplementationOnce(
      async (_url, options) =>
        executeInteractiveCaptureScript(options?.beforeContentScript ?? "", {
          buttonPresent: false,
        }).message,
    );
    const plan = validateChapterAcquisitionPlan({
      type: "page",
      url: "https://source.test/chapter/1",
      contentSelector: "article",
      interactions: [{ type: "click", selector: "button.more", timeoutMs: 300 }],
      loadStrategy: "selector",
    });
    if (plan.type !== "page") throw new Error("Expected page plan.");

    await expect(
      captureChapterPage(plan, {
        contentType: "html",
        executor: "immediate",
        sourceId: "source-a",
      }),
    ).rejects.toThrow(
      'interaction-failed: Interaction step 1 (click "button.more") timed out after 300ms.',
    );
  });

  it("reports a manual-action marker that appears during interactions", async () => {
    mockedCaptureChapterWebView.mockImplementationOnce(
      async (_url, options) =>
        executeInteractiveCaptureScript(options?.beforeContentScript ?? "", {
          manualActionAfterClick: true,
        }).message,
    );
    const plan = validateChapterAcquisitionPlan({
      type: "page",
      url: "https://source.test/chapter/1",
      contentSelector: "article",
      interactions: [
        { type: "click", selector: "button.more" },
        { type: "waitFor", selector: ".never" },
      ],
      loadStrategy: "selector",
    });
    if (plan.type !== "page") throw new Error("Expected page plan.");

    await expect(
      captureChapterPage(plan, {
        contentType: "html",
        executor: "immediate",
        sourceId: "source-a",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isSourceAccessRequiredError(error) && error.challenge.kind === "captcha",
    );
  });
});
