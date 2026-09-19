import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { WebViewInteraction } from "./types";
import {
  MAX_WEBVIEW_INTERACTIONS,
  nextWebViewInteractionRunId,
  validateWebViewInteractions,
  webViewInteractionRuntimeScript,
} from "./webview-interactions";

interface RecordedEvent {
  type: string;
  init: Record<string, unknown>;
}

class FakeEvent {
  readonly type: string;
  readonly init: Record<string, unknown>;

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.init = init;
  }
}

class FakeMouseEvent extends FakeEvent {}
class FakePointerEvent extends FakeMouseEvent {}
class FakeKeyboardEvent extends FakeEvent {}
class FakeInputEvent extends FakeEvent {}

interface FakeElement {
  tagName: string;
  value: string;
  clicked: number;
  focused: number;
  isContentEditable: boolean;
  events: RecordedEvent[];
  textContent: string;
  options?: Array<{ value: string; textContent: string }>;
  form?: { requestSubmit: () => void; submitted: number };
  appendChild(node: { text: string }): void;
  click(): void;
  dispatchEvent(event: FakeEvent): boolean;
  focus(): void;
  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  scrollIntoView(): void;
}

function fakeElement(
  tagName: string,
  overrides: Partial<FakeElement> = {},
): FakeElement {
  const element: FakeElement = {
    tagName,
    value: "",
    clicked: 0,
    focused: 0,
    isContentEditable: false,
    events: [],
    textContent: "",
    appendChild(node) {
      element.textContent += node.text;
    },
    click() {
      element.clicked += 1;
    },
    dispatchEvent(event) {
      element.events.push({ type: event.type, init: event.init });
      return true;
    },
    focus() {
      element.focused += 1;
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 100, height: 40 };
    },
    scrollIntoView() {},
    ...overrides,
  };
  return element;
}

function memoryStorage(): Storage & { writes: number } {
  const values = new Map<string, string>();
  return {
    writes: 0,
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      this.writes += 1;
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  } as Storage & { writes: number };
}

interface RunOptions {
  elements: Record<string, FakeElement | (() => FakeElement | null)>;
  runId?: string;
  sessionStorage?: Storage;
  shouldAbort?: () => boolean;
  /** Stops the timer drain, which mimics the document unloading. */
  stopWhen?: () => boolean;
  window?: Record<string, unknown>;
}

interface RunResult {
  aborted: boolean;
  elapsedMs: number;
  error: Error | null;
  finished: boolean;
}

function runInteractions(
  steps: WebViewInteraction[],
  options: RunOptions,
): RunResult {
  const timers: Array<{ at: number; callback: () => void }> = [];
  let now = 0;
  let outcome: { error: Error | null; aborted: boolean } | undefined;
  const context = {
    Date: { now: () => now },
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
    KeyboardEvent: FakeKeyboardEvent,
    MouseEvent: FakeMouseEvent,
    PointerEvent: FakePointerEvent,
    document: {
      createTextNode: (text: string) => ({ text }),
      execCommand: () => false,
      querySelector(selector: string) {
        const entry = options.elements[selector];
        return typeof entry === "function" ? entry() : (entry ?? null);
      },
    },
    runId: options.runId ?? "run-1",
    sessionStorage: options.sessionStorage ?? memoryStorage(),
    setTimeout(callback: () => void, delay: number) {
      timers.push({ at: now + delay, callback });
      return timers.length;
    },
    shouldAbort: options.shouldAbort,
    steps,
    window: options.window ?? {},
    __done(value: { error: Error | null; aborted: boolean }) {
      outcome = value;
    },
  };
  runInNewContext(
    `${webViewInteractionRuntimeScript()}
runWebViewInteractions(steps, { runId: runId, shouldAbort: shouldAbort }, function (error, aborted) {
  __done({ error: error, aborted: aborted });
});`,
    context,
  );
  while (!outcome && timers.length > 0 && !options.stopWhen?.()) {
    timers.sort((left, right) => left.at - right.at);
    const next = timers.shift()!;
    now = Math.max(now, next.at);
    next.callback();
  }
  return {
    aborted: outcome?.aborted ?? false,
    elapsedMs: now,
    error: outcome?.error ?? null,
    finished: outcome !== undefined,
  };
}

function eventTypes(element: FakeElement): string[] {
  return element.events.map((event) => event.type);
}

describe("validateWebViewInteractions", () => {
  it("normalizes supported steps and clamps timeouts", () => {
    expect(
      validateWebViewInteractions(
        [
          { type: "click", selector: " .more ", timeoutMs: 50 },
          {
            type: "type",
            selector: "#search",
            text: "moon",
            clear: true,
            submit: true,
          },
          { type: "select", selector: "select", value: "asc", optional: true },
          { type: "waitFor", selector: ".list", timeoutMs: 999_999 },
        ],
        "webViewLoad",
      ),
    ).toEqual([
      { type: "click", selector: ".more", timeoutMs: 100 },
      {
        type: "type",
        selector: "#search",
        text: "moon",
        clear: true,
        submit: true,
      },
      { type: "select", selector: "select", value: "asc", optional: true },
      { type: "waitFor", selector: ".list", timeoutMs: 120_000 },
    ]);
  });

  it("rejects malformed steps with the caller context", () => {
    expect(() => validateWebViewInteractions({}, "Chapter acquisition")).toThrow(
      "Chapter acquisition interactions must be an array.",
    );
    expect(() =>
      validateWebViewInteractions(
        Array.from({ length: MAX_WEBVIEW_INTERACTIONS + 1 }, () => ({
          type: "click",
          selector: "a",
        })),
        "webViewLoad",
      ),
    ).toThrow("webViewLoad has too many interactions.");
    expect(() =>
      validateWebViewInteractions([{ type: "hover", selector: "a" }], "webViewLoad"),
    ).toThrow("interactions[0].type must be click, type, select, or waitFor.");
    expect(() =>
      validateWebViewInteractions([{ type: "click", selector: " " }], "webViewLoad"),
    ).toThrow("interactions[0].selector must be a non-empty selector.");
    expect(() =>
      validateWebViewInteractions([{ type: "type", selector: "input" }], "webViewLoad"),
    ).toThrow("interactions[0].text must be a string.");
    expect(() =>
      validateWebViewInteractions(
        [{ type: "type", selector: "input", text: "x".repeat(2_049) }],
        "webViewLoad",
      ),
    ).toThrow("interactions[0].text is too long.");
    expect(() =>
      validateWebViewInteractions([{ type: "select", selector: "select" }], "webViewLoad"),
    ).toThrow("interactions[0].value must be a string.");
    expect(() =>
      validateWebViewInteractions(
        [{ type: "click", selector: "a", optional: "yes" }],
        "webViewLoad",
      ),
    ).toThrow("interactions[0].optional must be a boolean.");
    expect(() =>
      validateWebViewInteractions(
        [{ type: "waitFor", selector: "a", timeoutMs: Number.NaN }],
        "webViewLoad",
      ),
    ).toThrow("interactions[0].timeoutMs must be a finite number.");
  });
});

describe("nextWebViewInteractionRunId", () => {
  it("returns distinct ids", () => {
    expect(nextWebViewInteractionRunId()).not.toBe(nextWebViewInteractionRunId());
  });
});

describe("runWebViewInteractions", () => {
  it("clicks a target once it appears using a user-like event sequence", () => {
    const button = fakeElement("BUTTON");
    let polls = 0;
    const result = runInteractions([{ type: "click", selector: ".more" }], {
      elements: {
        ".more": () => {
          polls += 1;
          return polls >= 3 ? button : null;
        },
      },
    });

    expect(result).toMatchObject({ aborted: false, error: null, finished: true });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(200);
    expect(eventTypes(button)).toEqual([
      "pointerover",
      "mouseover",
      "pointermove",
      "mousemove",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
    ]);
    expect(button.events[4]?.init).toMatchObject({
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 60,
      clientY: 40,
      pointerType: "mouse",
    });
    expect(button.focused).toBe(1);
    expect(button.clicked).toBe(1);
  });

  it("fails a required step whose target never appears", () => {
    const result = runInteractions(
      [{ type: "click", selector: ".missing", timeoutMs: 500 }],
      { elements: {} },
    );

    expect(result.finished).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.error?.message).toBe(
      'Interaction step 1 (click ".missing") timed out after 500ms.',
    );
    expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
  });

  it("skips optional steps and keeps going", () => {
    const button = fakeElement("BUTTON");
    const result = runInteractions(
      [
        { type: "click", selector: ".popup-close", optional: true, timeoutMs: 100 },
        { type: "click", selector: ".more" },
      ],
      { elements: { ".more": button } },
    );

    expect(result.error).toBeNull();
    expect(button.clicked).toBe(1);
  });

  it("types text character by character, clears the field, and submits the form", () => {
    const form = {
      submitted: 0,
      requestSubmit() {
        form.submitted += 1;
      },
    };
    const input = fakeElement("INPUT", { value: "old", form });
    const nativeSets: string[] = [];
    const result = runInteractions(
      [
        {
          type: "type",
          selector: "#search",
          text: "ab",
          clear: true,
          submit: true,
        },
      ],
      {
        elements: { "#search": input },
        window: {
          HTMLInputElement: {
            prototype: Object.defineProperty({}, "value", {
              configurable: true,
              set(this: FakeElement, value: string) {
                nativeSets.push(value);
                Object.defineProperty(this, "value", {
                  configurable: true,
                  writable: true,
                  value,
                });
              },
            }),
          },
        },
      },
    );

    expect(result.error).toBeNull();
    expect(input.value).toBe("ab");
    expect(nativeSets).toEqual(["", "a", "ab"]);
    expect(input.focused).toBe(1);
    expect(eventTypes(input)).toEqual([
      "input",
      "keydown",
      "keypress",
      "beforeinput",
      "input",
      "keyup",
      "keydown",
      "keypress",
      "beforeinput",
      "input",
      "keyup",
      "change",
      "keydown",
      "keypress",
      "keyup",
    ]);
    expect(input.events[0]?.init).toMatchObject({
      inputType: "deleteContentBackward",
    });
    expect(input.events[1]?.init).toMatchObject({
      code: "KeyA",
      key: "a",
      keyCode: 65,
    });
    expect(input.events[4]?.init).toMatchObject({
      data: "a",
      inputType: "insertText",
    });
    expect(input.events[12]?.init).toMatchObject({ key: "Enter", keyCode: 13 });
    expect(form.submitted).toBe(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(40);
  });

  it("types into contenteditable targets and rejects non-editable ones", () => {
    const editor = fakeElement("DIV", { isContentEditable: true });
    expect(
      runInteractions([{ type: "type", selector: ".editor", text: "hi" }], {
        elements: { ".editor": editor },
      }).error,
    ).toBeNull();
    expect(editor.textContent).toBe("hi");

    const heading = fakeElement("H1");
    expect(
      runInteractions([{ type: "type", selector: "h1", text: "hi" }], {
        elements: { h1: heading },
      }).error?.message,
    ).toBe(
      'Interaction step 1 (type "h1") failed: target is not an input, textarea, or contenteditable element',
    );
  });

  it("selects an option by value or visible text", () => {
    const options = [
      { value: "asc", textContent: " Oldest first " },
      { value: "desc", textContent: "Newest first" },
    ];
    const byValue = fakeElement("SELECT", { options });
    expect(
      runInteractions([{ type: "select", selector: "select", value: "desc" }], {
        elements: { select: byValue },
      }).error,
    ).toBeNull();
    expect(byValue.value).toBe("desc");
    expect(eventTypes(byValue)).toEqual(["input", "change"]);

    const byText = fakeElement("SELECT", { options });
    expect(
      runInteractions(
        [{ type: "select", selector: "select", value: "Oldest first" }],
        { elements: { select: byText } },
      ).error,
    ).toBeNull();
    expect(byText.value).toBe("asc");

    const noMatch = fakeElement("SELECT", { options });
    expect(
      runInteractions([{ type: "select", selector: "select", value: "random" }], {
        elements: { select: noMatch },
      }).error?.message,
    ).toBe('Interaction step 1 (select "select") failed: no option matches "random"');
  });

  it("resumes after a navigating step without replaying earlier steps", () => {
    const storage = memoryStorage();
    let navigated = false;
    const link = fakeElement("A", {
      click() {
        link.clicked += 1;
        navigated = true;
      },
    });
    const more = fakeElement("BUTTON");
    const steps: WebViewInteraction[] = [
      { type: "click", selector: "a.sort" },
      { type: "click", selector: ".more" },
    ];

    const firstDocument = runInteractions(steps, {
      elements: { "a.sort": link, ".more": more },
      sessionStorage: storage,
      stopWhen: () => navigated,
    });
    expect(firstDocument.finished).toBe(false);
    expect(link.clicked).toBe(1);
    expect(more.clicked).toBe(0);
    expect(storage.getItem("norea-interactions:run-1")).toBe("1");

    const secondDocument = runInteractions(steps, {
      elements: { "a.sort": link, ".more": more },
      sessionStorage: storage,
    });
    expect(secondDocument).toMatchObject({ error: null, finished: true });
    expect(link.clicked).toBe(1);
    expect(more.clicked).toBe(1);
    expect(storage.getItem("norea-interactions:run-1")).toBeNull();
  });

  it("hands control back when the caller reports a manual action", () => {
    const button = fakeElement("BUTTON");
    const result = runInteractions([{ type: "click", selector: ".more" }], {
      elements: { ".more": button },
      shouldAbort: () => true,
    });

    expect(result).toMatchObject({ aborted: true, error: null, finished: true });
    expect(button.clicked).toBe(0);
  });

  it("completes immediately without touching storage when there are no steps", () => {
    const storage = memoryStorage();
    const result = runInteractions([], { elements: {}, sessionStorage: storage });

    expect(result).toMatchObject({
      aborted: false,
      elapsedMs: 0,
      error: null,
      finished: true,
    });
    expect(storage.writes).toBe(0);
  });
});
