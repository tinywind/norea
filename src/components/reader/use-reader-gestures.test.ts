import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  READER_GENERAL_DEFAULTS,
  TAP_ZONE_DEFAULTS,
  type ReaderGeneralSettings,
} from "../../store/reader";
import { stopReaderMediaClick } from "./reader-content-media";
import { openReaderLink } from "./reader-links";
import { useReaderGestures } from "./use-reader-gestures";

vi.mock("./reader-links", async (importOriginal) => ({
  ...await importOriginal<typeof import("./reader-links")>(),
  openReaderLink: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
  useRef: <T,>(current: T) => ({ current }),
}));

class FakeNode extends EventTarget {
  parentElement: FakeElement | null = null;
}

class FakeElement extends FakeNode {
  constructor(
    readonly tagName: string,
    parent: FakeElement | null = null,
    readonly role: string | null = null,
    readonly href: string | null = null,
  ) {
    super();
    this.parentElement = parent;
  }

  private matches(selector: string): boolean {
    const roleMatch = /^\[role='([^']+)'\]$/.exec(selector);
    if (roleMatch) return this.role === roleMatch[1];
    if (selector === "a[href]") return this.tagName === "a" && this.href !== null;
    return selector === this.tagName;
  }

  getAttribute(name: string): string | null {
    return name === "href" ? this.href : null;
  }

  closest(selectors: string): FakeElement | null {
    const list = selectors.split(",").map((selector) => selector.trim());
    for (
      let element: FakeElement | null = this;
      element;
      element = element.parentElement
    ) {
      if (list.some((selector) => element!.matches(selector))) return element;
    }
    return null;
  }

  querySelector(): FakeElement | null {
    return null;
  }
}

class FakeHtmlElement extends FakeElement {}

const VIEWPORT_RECT = { left: 0, top: 0, width: 300, height: 300 };
const ZONE_POINTS = {
  middleLeft: { clientX: 20, clientY: 150 },
  middleCenter: { clientX: 150, clientY: 150 },
  middleRight: { clientX: 280, clientY: 150 },
  topCenter: { clientX: 150, clientY: 20 },
  bottomCenter: { clientX: 150, clientY: 280 },
};

let selectionText = "";

function mountGestures(
  overrides: {
    chromeDismissible?: boolean;
    general?: Partial<ReaderGeneralSettings>;
    interactionBlocked?: boolean;
    isPagedReader?: boolean;
    onToggleChrome?: (() => void) | undefined;
    viewport?: Partial<{
      clientHeight: number;
      clientLeft: number;
      clientTop: number;
      clientWidth: number;
      rect: { left: number; top: number; width: number; height: number };
    }>;
  } = {},
) {
  const scrollByPage = vi.fn();
  const hasOnToggleChromeOverride = "onToggleChrome" in overrides;
  const onToggleChrome = hasOnToggleChromeOverride
    ? overrides.onToggleChrome
    : vi.fn();
  const nativeWheelActionLockedUntilRef = { current: 0 };
  const general = { ...READER_GENERAL_DEFAULTS, ...overrides.general };
  const rect = overrides.viewport?.rect ?? VIEWPORT_RECT;
  const handlers = useReaderGestures({
    chromeDismissible: overrides.chromeDismissible ?? false,
    interactionBlocked: overrides.interactionBlocked ?? false,
    isPagedReader: overrides.isPagedReader ?? false,
    general,
    viewportRef: {
      current: {
        clientHeight: overrides.viewport?.clientHeight,
        clientLeft: overrides.viewport?.clientLeft,
        clientTop: overrides.viewport?.clientTop,
        clientWidth: overrides.viewport?.clientWidth,
        getBoundingClientRect: () => rect,
      } as unknown as HTMLDivElement,
    },
    getActiveScrollNode: () => null,
    scrollByPage,
    onToggleChrome,
    nativeWheelActionLockedUntilRef,
  });
  return { handlers, scrollByPage, onToggleChrome, nativeWheelActionLockedUntilRef };
}

type Handlers = ReturnType<typeof mountGestures>["handlers"];

function pointerDown(handlers: Handlers, pointerType = "touch") {
  handlers.handlePointerDown({ pointerType } as unknown as Parameters<Handlers["handlePointerDown"]>[0]);
}

function mouseDown(
  handlers: Handlers,
  point: { clientX: number; clientY: number },
  target: FakeElement = new FakeHtmlElement("p"),
  {
    altKey = false,
    button = 0,
    ctrlKey = false,
    detail = 1,
    metaKey = false,
    pointerType = "mouse",
    shiftKey = false,
  }: {
    altKey?: boolean;
    button?: number;
    ctrlKey?: boolean;
    detail?: number;
    metaKey?: boolean;
    pointerType?: string;
    shiftKey?: boolean;
  } = {},
) {
  const event = {
    ...point,
    altKey,
    button,
    ctrlKey,
    detail,
    metaKey,
    shiftKey,
    target,
    preventDefault: vi.fn(),
  };
  pointerDown(handlers, pointerType);
  handlers.handleMouseDown(event as unknown as Parameters<Handlers["handleMouseDown"]>[0]);
  return event;
}

function tap(
  handlers: Handlers,
  point: { clientX: number; clientY: number },
  target: FakeElement = new FakeHtmlElement("p"),
  {
    button = 0,
    detail = 1,
    pointerType = "touch",
  }: { button?: number; detail?: number; pointerType?: string } = {},
) {
  const mouseDownEvent = mouseDown(handlers, point, target, {
    button,
    detail,
    pointerType,
  });
  const event = { ...point, button, detail, target, preventDefault: vi.fn() };
  handlers.handleClick(event as unknown as Parameters<Handlers["handleClick"]>[0]);
  return { ...event, mouseDownEvent };
}

function swipe(handlers: Handlers, from: { x: number; y: number }, to: { x: number; y: number }) {
  handlers.handleTouchStart({
    changedTouches: [{ clientX: from.x, clientY: from.y }],
  } as unknown as Parameters<Handlers["handleTouchStart"]>[0]);
  handlers.handleTouchEnd({
    changedTouches: [{ clientX: to.x, clientY: to.y }],
  } as unknown as Parameters<Handlers["handleTouchEnd"]>[0]);
}

function wheel(handlers: Handlers, deltaY: number, init: { ctrlKey?: boolean } = {}) {
  const event = {
    ctrlKey: init.ctrlKey ?? false,
    deltaMode: 0,
    deltaX: 0,
    deltaY,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    target: new FakeElement("p"),
  };
  handlers.handleWheel(event as unknown as Parameters<Handlers["handleWheel"]>[0]);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  selectionText = "";
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeHtmlElement);
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("window", {
    getSelection: () => ({
      isCollapsed: selectionText === "",
      toString: () => selectionText,
    }),
    innerHeight: 800,
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: number) => clearTimeout(id),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(openReaderLink).mockClear();
});

describe("reader tap contract", () => {
  it("toggles the chrome from the center zone even when tap paging is off", () => {
    const { handlers, onToggleChrome, scrollByPage } = mountGestures({
      general: { tapToScroll: false },
    });
    tap(handlers, ZONE_POINTS.middleCenter);
    expect(onToggleChrome).toHaveBeenCalledOnce();
    expect(scrollByPage).not.toHaveBeenCalled();
  });

  it("pages through the default zone map when tap paging is on", () => {
    const { handlers, scrollByPage } = mountGestures();
    expect(TAP_ZONE_DEFAULTS.middleLeft).toBe("previous");
    tap(handlers, ZONE_POINTS.middleLeft);
    tap(handlers, ZONE_POINTS.middleRight);
    tap(handlers, ZONE_POINTS.topCenter);
    tap(handlers, ZONE_POINTS.bottomCenter);
    expect(scrollByPage.mock.calls).toEqual([
      [-1, "tap-previous"],
      [1, "tap-next"],
      [-1, "tap-previous"],
      [1, "tap-next"],
    ]);
  });

  it("keeps a custom menu zone active when tap paging is off", () => {
    const { handlers, onToggleChrome, scrollByPage } = mountGestures({
      general: { tapToScroll: false, tapZones: { ...TAP_ZONE_DEFAULTS, topCenter: "menu" } },
    });
    tap(handlers, ZONE_POINTS.topCenter);
    expect(onToggleChrome).toHaveBeenCalledOnce();
    expect(scrollByPage).not.toHaveBeenCalled();
  });

  it("ignores side zones when tap paging is off", () => {
    const { handlers, scrollByPage, onToggleChrome } = mountGestures({
      general: { tapToScroll: false },
    });
    tap(handlers, ZONE_POINTS.middleLeft);
    tap(handlers, ZONE_POINTS.middleRight);
    expect(scrollByPage).not.toHaveBeenCalled();
    expect(onToggleChrome).not.toHaveBeenCalled();
  });

  it("follows a custom zone map, including zones turned off", () => {
    const { handlers, scrollByPage, onToggleChrome } = mountGestures({
      general: {
        tapZones: { ...TAP_ZONE_DEFAULTS, middleLeft: "next", middleRight: "none" },
      },
    });
    tap(handlers, ZONE_POINTS.middleLeft);
    tap(handlers, ZONE_POINTS.middleRight);
    expect(scrollByPage.mock.calls).toEqual([[1, "tap-next"]]);
    expect(onToggleChrome).not.toHaveBeenCalled();
  });

  it.each([
    ["an anchor without a destination", () => new FakeElement("span", new FakeElement("a"))],
    ["a button", () => new FakeElement("button")],
    ["a slider", () => new FakeElement("span", new FakeElement("div", null, "slider"))],
    ["media with its own controls", () => new FakeElement("video")],
  ])("leaves a tap on %s to that element", (_label, target) => {
    const { handlers, scrollByPage, onToggleChrome } = mountGestures();
    tap(handlers, ZONE_POINTS.middleRight, target());
    tap(handlers, ZONE_POINTS.middleCenter, target());
    expect(scrollByPage).not.toHaveBeenCalled();
    expect(onToggleChrome).not.toHaveBeenCalled();
  });

  it("does nothing while interaction is blocked", () => {
    const { handlers, scrollByPage, onToggleChrome } = mountGestures({
      interactionBlocked: true,
    });
    tap(handlers, ZONE_POINTS.middleRight);
    tap(handlers, ZONE_POINTS.middleCenter);
    expect(scrollByPage).not.toHaveBeenCalled();
    expect(onToggleChrome).not.toHaveBeenCalled();
  });

  it("hides visible full-page chrome with any tap instead of paging", () => {
    const { handlers, scrollByPage, onToggleChrome } = mountGestures({
      chromeDismissible: true,
    });
    tap(handlers, ZONE_POINTS.middleRight);
    tap(handlers, ZONE_POINTS.middleLeft);
    expect(onToggleChrome).toHaveBeenCalledTimes(2);
    expect(scrollByPage).not.toHaveBeenCalled();
  });

  it("leaves a tap that ends a text selection to the selection", () => {
    const { handlers, scrollByPage, onToggleChrome } = mountGestures();
    selectionText = "selected words";
    tap(handlers, ZONE_POINTS.middleRight);
    tap(handlers, ZONE_POINTS.middleCenter);
    expect(scrollByPage).not.toHaveBeenCalled();
    expect(onToggleChrome).not.toHaveBeenCalled();
  });

  it("only clears an existing selection with the next tap, then pages again", () => {
    const { handlers, scrollByPage } = mountGestures();
    selectionText = "selected words";
    pointerDown(handlers);
    selectionText = "";
    handlers.handleClick({
      ...ZONE_POINTS.middleRight,
      target: new FakeElement("p"),
      preventDefault: vi.fn(),
    } as unknown as Parameters<Handlers["handleClick"]>[0]);
    expect(scrollByPage).not.toHaveBeenCalled();
    tap(handlers, ZONE_POINTS.middleRight);
    expect(scrollByPage).toHaveBeenCalledWith(1, "tap-next");
  });

  it("pages and toggles chrome immediately on mouse click without waiting for a timer", () => {
    const { handlers, scrollByPage, onToggleChrome } = mountGestures();
    const first = tap(handlers, ZONE_POINTS.middleRight, undefined, { pointerType: "mouse" });
    expect(first.mouseDownEvent.preventDefault).not.toHaveBeenCalled();
    expect(scrollByPage).toHaveBeenCalledWith(1, "tap-next");
    const center = tap(handlers, ZONE_POINTS.middleCenter, undefined, { pointerType: "mouse" });
    expect(center.mouseDownEvent.preventDefault).not.toHaveBeenCalled();
    expect(onToggleChrome).toHaveBeenCalledOnce();
  });

  it("pages on every rapid mouse click and suppresses multi-click text selection in active zones", () => {
    const { handlers, scrollByPage } = mountGestures();
    for (let detail = 1; detail <= 5; detail += 1) {
      const event = tap(handlers, ZONE_POINTS.middleRight, undefined, {
        detail,
        pointerType: "mouse",
      });
      if (detail === 1) {
        expect(event.mouseDownEvent.preventDefault).not.toHaveBeenCalled();
      } else {
        expect(event.mouseDownEvent.preventDefault).toHaveBeenCalledOnce();
      }
    }
    expect(scrollByPage).toHaveBeenCalledTimes(5);
    expect(scrollByPage).toHaveBeenLastCalledWith(1, "tap-next");
  });

  it("pages on every quick touch tap without preventing compatibility mousedown", () => {
    const { handlers, scrollByPage } = mountGestures();
    for (let detail = 1; detail <= 5; detail += 1) {
      const event = tap(handlers, ZONE_POINTS.middleRight, undefined, { detail });
      expect(event.mouseDownEvent.preventDefault).not.toHaveBeenCalled();
    }
    expect(scrollByPage).toHaveBeenCalledTimes(5);
    expect(scrollByPage).toHaveBeenLastCalledWith(1, "tap-next");
  });

  it("pages on every rapid pen tap and suppresses multi-click text selection in active zones", () => {
    const { handlers, scrollByPage } = mountGestures();
    for (let detail = 1; detail <= 3; detail += 1) {
      const event = tap(handlers, ZONE_POINTS.middleRight, undefined, {
        detail,
        pointerType: "pen",
      });
      if (detail === 1) {
        expect(event.mouseDownEvent.preventDefault).not.toHaveBeenCalled();
      } else {
        expect(event.mouseDownEvent.preventDefault).toHaveBeenCalledOnce();
      }
    }
    expect(scrollByPage).toHaveBeenCalledTimes(3);
  });

  it("preserves double-click selection in menu zones when chrome toggling is unavailable", () => {
    const normal = mountGestures({
      general: {
        tapToScroll: true,
        tapZones: { ...TAP_ZONE_DEFAULTS, topCenter: "menu" },
      },
      onToggleChrome: undefined,
    });
    expect(
      mouseDown(normal.handlers, ZONE_POINTS.middleCenter, undefined, {
        detail: 2,
        pointerType: "mouse",
      }).preventDefault,
    ).not.toHaveBeenCalled();
    expect(
      mouseDown(normal.handlers, ZONE_POINTS.topCenter, undefined, {
        detail: 2,
        pointerType: "mouse",
      }).preventDefault,
    ).not.toHaveBeenCalled();
    expect(
      mouseDown(normal.handlers, ZONE_POINTS.middleRight, undefined, {
        detail: 2,
        pointerType: "mouse",
      }).preventDefault,
    ).toHaveBeenCalledOnce();

    const noTapNoMenu = mountGestures({
      general: { tapToScroll: false },
      onToggleChrome: undefined,
    });
    expect(
      mouseDown(noTapNoMenu.handlers, ZONE_POINTS.middleCenter, undefined, {
        detail: 2,
        pointerType: "mouse",
      }).preventDefault,
    ).not.toHaveBeenCalled();
  });

  it("does not intercept or prevent multi-clicks on the viewport scrollbar", () => {
    const ltr = mountGestures({
      viewport: {
        clientWidth: 282,
        clientHeight: 300,
        rect: { left: 0, top: 0, width: 300, height: 300 },
      },
    });
    const ltrScrollbarTap = tap(
      ltr.handlers,
      { clientX: 290, clientY: 150 },
      undefined,
      { detail: 2, pointerType: "mouse" },
    );
    expect(ltrScrollbarTap.mouseDownEvent.preventDefault).not.toHaveBeenCalled();
    expect(ltr.scrollByPage).not.toHaveBeenCalled();

    const rtl = mountGestures({
      viewport: {
        clientLeft: 18,
        clientWidth: 282,
        clientHeight: 300,
        rect: { left: 0, top: 0, width: 300, height: 300 },
      },
    });
    const rtlScrollbarTap = tap(
      rtl.handlers,
      { clientX: 8, clientY: 150 },
      undefined,
      { detail: 2, pointerType: "mouse" },
    );
    expect(rtlScrollbarTap.mouseDownEvent.preventDefault).not.toHaveBeenCalled();
    expect(rtl.scrollByPage).not.toHaveBeenCalled();

    const fractionalDpr = mountGestures({
      viewport: {
        clientWidth: 300,
        clientHeight: 300,
        rect: { left: 0, top: 0, width: 300.5, height: 300.5 },
      },
    });
    const contentTap = tap(
      fractionalDpr.handlers,
      ZONE_POINTS.middleRight,
      undefined,
      { detail: 2, pointerType: "mouse" },
    );
    expect(contentTap.mouseDownEvent.preventDefault).toHaveBeenCalledOnce();
    expect(fractionalDpr.scrollByPage).toHaveBeenCalledWith(1, "tap-next");
  });

  it("does not prevent multi-click mousedown when modifier keys are held or target is an SVG inside a button", () => {
    const { handlers, scrollByPage } = mountGestures();
    for (const modifier of ["shiftKey", "ctrlKey", "altKey", "metaKey"] as const) {
      expect(
        mouseDown(handlers, ZONE_POINTS.middleRight, undefined, {
          detail: 2,
          pointerType: "mouse",
          [modifier]: true,
        }).preventDefault,
      ).not.toHaveBeenCalled();
    }
    const buttonSvgRect = new FakeElement(
      "rect",
      new FakeElement("svg", new FakeHtmlElement("button")),
    );
    const svgButtonTap = tap(handlers, ZONE_POINTS.middleRight, buttonSvgRect, {
      detail: 2,
      pointerType: "mouse",
    });
    expect(svgButtonTap.mouseDownEvent.preventDefault).not.toHaveBeenCalled();
    expect(scrollByPage).not.toHaveBeenCalled();
  });

  it("keeps mouse drag text selection working in active tap zones", () => {
    const { handlers, scrollByPage } = mountGestures();
    const down = mouseDown(handlers, ZONE_POINTS.middleRight, undefined, {
      detail: 1,
      pointerType: "mouse",
    });
    expect(down.preventDefault).not.toHaveBeenCalled();
    selectionText = "dragged selection";
    handlers.handleClick({
      ...ZONE_POINTS.middleRight,
      button: 0,
      detail: 1,
      target: new FakeElement("p"),
      preventDefault: vi.fn(),
    } as unknown as Parameters<Handlers["handleClick"]>[0]);
    expect(scrollByPage).not.toHaveBeenCalled();
  });

  it("preserves mouse double-click selection when tap paging is off or the zone action is none", () => {
    const off = mountGestures({ general: { tapToScroll: false } });
    const leftDouble = mouseDown(off.handlers, ZONE_POINTS.middleLeft, undefined, {
      detail: 2,
      pointerType: "mouse",
    });
    const rightDouble = mouseDown(off.handlers, ZONE_POINTS.middleRight, undefined, {
      detail: 2,
      pointerType: "mouse",
    });
    const centerDouble = mouseDown(off.handlers, ZONE_POINTS.middleCenter, undefined, {
      detail: 2,
      pointerType: "mouse",
    });
    expect(leftDouble.preventDefault).not.toHaveBeenCalled();
    expect(rightDouble.preventDefault).not.toHaveBeenCalled();
    expect(centerDouble.preventDefault).toHaveBeenCalledOnce();

    const custom = mountGestures({
      general: { tapZones: { ...TAP_ZONE_DEFAULTS, middleRight: "none" } },
    });
    const noneZoneDouble = mouseDown(custom.handlers, ZONE_POINTS.middleRight, undefined, {
      detail: 2,
      pointerType: "mouse",
    });
    expect(noneZoneDouble.preventDefault).not.toHaveBeenCalled();
  });

  it("suppresses mouse multi-click selection everywhere while dismissible chrome is visible", () => {
    const { handlers } = mountGestures({
      chromeDismissible: true,
      general: { tapToScroll: false },
    });
    const down = mouseDown(handlers, ZONE_POINTS.middleRight, undefined, {
      detail: 2,
      pointerType: "mouse",
    });
    expect(down.preventDefault).toHaveBeenCalledOnce();
  });

  it("does not prevent multi-click mousedown for non-primary buttons, active selection, interactive targets, or blocked interaction", () => {
    const { handlers } = mountGestures();
    expect(
      mouseDown(handlers, ZONE_POINTS.middleRight, undefined, {
        button: 2,
        detail: 2,
        pointerType: "mouse",
      }).preventDefault,
    ).not.toHaveBeenCalled();
    expect(
      mouseDown(handlers, ZONE_POINTS.middleRight, new FakeElement("input"), {
        detail: 2,
        pointerType: "mouse",
      }).preventDefault,
    ).not.toHaveBeenCalled();
    const anchor = new FakeElement("a", null, null, "https://example.com");
    expect(
      mouseDown(handlers, ZONE_POINTS.middleRight, new FakeElement("span", anchor), {
        detail: 2,
        pointerType: "mouse",
      }).preventDefault,
    ).not.toHaveBeenCalled();
    expect(
      mouseDown(handlers, ZONE_POINTS.middleRight, new FakeElement("img", anchor), {
        detail: 2,
        pointerType: "mouse",
      }).preventDefault,
    ).toHaveBeenCalledOnce();

    selectionText = "existing selection";
    expect(
      mouseDown(handlers, ZONE_POINTS.middleRight, undefined, {
        detail: 2,
        pointerType: "mouse",
      }).preventDefault,
    ).not.toHaveBeenCalled();
    selectionText = "";

    const blocked = mountGestures({ interactionBlocked: true });
    expect(
      mouseDown(blocked.handlers, ZONE_POINTS.middleRight, undefined, {
        detail: 2,
        pointerType: "mouse",
      }).preventDefault,
    ).not.toHaveBeenCalled();
  });

  it("clears an existing selection with a mouse click, then pages immediately on a rapid follow-up click", () => {
    const { handlers, scrollByPage } = mountGestures();
    selectionText = "selected words";
    const clearDown = mouseDown(handlers, ZONE_POINTS.middleRight, undefined, {
      detail: 1,
      pointerType: "mouse",
    });
    expect(clearDown.preventDefault).not.toHaveBeenCalled();
    selectionText = "";
    handlers.handleClick({
      ...ZONE_POINTS.middleRight,
      button: 0,
      detail: 1,
      target: new FakeElement("p"),
      preventDefault: vi.fn(),
    } as unknown as Parameters<Handlers["handleClick"]>[0]);
    expect(scrollByPage).not.toHaveBeenCalled();

    const nextTap = tap(handlers, ZONE_POINTS.middleRight, undefined, {
      detail: 2,
      pointerType: "mouse",
    });
    expect(nextTap.mouseDownEvent.preventDefault).toHaveBeenCalledOnce();
    expect(scrollByPage).toHaveBeenCalledWith(1, "tap-next");
  });

  it("opens a chapter link outside the app instead of paging or toggling chrome", () => {
    const { handlers, scrollByPage, onToggleChrome } = mountGestures({
      chromeDismissible: true,
    });
    const anchor = new FakeElement("a", null, null, "https://example.com/notes");
    const event = tap(handlers, ZONE_POINTS.middleRight, new FakeElement("span", anchor));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(openReaderLink).toHaveBeenCalledWith(anchor);
    expect(scrollByPage).not.toHaveBeenCalled();
    expect(onToggleChrome).not.toHaveBeenCalled();
  });
});

describe("reader media interception contract", () => {
  it("passes still-image clicks on to the tap handler without their default", () => {
    const event = {
      target: new FakeElement("img", new FakeElement("figure")),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    stopReaderMediaClick(event as unknown as Parameters<typeof stopReaderMediaClick>[0]);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("keeps clicks on media with its own controls", () => {
    const event = {
      target: new FakeElement("video"),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    stopReaderMediaClick(event as unknown as Parameters<typeof stopReaderMediaClick>[0]);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("toggles chrome and pages when a webtoon image is tapped", () => {
    const { handlers, scrollByPage, onToggleChrome } = mountGestures({
      general: { tapToScroll: true },
    });
    tap(handlers, ZONE_POINTS.middleCenter, new FakeElement("img"));
    expect(onToggleChrome).toHaveBeenCalledOnce();
    tap(handlers, ZONE_POINTS.bottomCenter, new FakeElement("canvas"));
    expect(scrollByPage).toHaveBeenCalled();
  });

  it("does not open the link that wraps a tapped image", () => {
    const { handlers, onToggleChrome } = mountGestures();
    const anchor = new FakeElement("a", null, null, "https://example.com/next");
    tap(handlers, ZONE_POINTS.middleCenter, new FakeElement("img", anchor));
    expect(openReaderLink).not.toHaveBeenCalled();
    expect(onToggleChrome).toHaveBeenCalledOnce();
  });

  it("lets text clicks through", () => {
    const event = {
      target: new FakeElement("span", new FakeElement("p")),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    stopReaderMediaClick(event as unknown as Parameters<typeof stopReaderMediaClick>[0]);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});

describe("reader swipe contract", () => {
  it("pages forward on a left swipe and back on a right swipe", () => {
    const { handlers, scrollByPage } = mountGestures();
    swipe(handlers, { x: 200, y: 100 }, { x: 100, y: 110 });
    swipe(handlers, { x: 100, y: 100 }, { x: 200, y: 90 });
    expect(scrollByPage.mock.calls).toEqual([
      [1, "swipe"],
      [-1, "swipe"],
    ]);
  });

  it("does not page while a swipe adjusts a text selection", () => {
    const { handlers, scrollByPage } = mountGestures();
    selectionText = "selected words";
    swipe(handlers, { x: 200, y: 100 }, { x: 50, y: 100 });
    expect(scrollByPage).not.toHaveBeenCalled();
  });

  it("ignores short and mostly vertical swipes", () => {
    const { handlers, scrollByPage } = mountGestures();
    swipe(handlers, { x: 200, y: 100 }, { x: 150, y: 100 });
    swipe(handlers, { x: 200, y: 100 }, { x: 100, y: 300 });
    expect(scrollByPage).not.toHaveBeenCalled();
  });

  it("ignores swipes when swipe gestures are off or interaction is blocked", () => {
    const off = mountGestures({ general: { swipeGestures: false } });
    swipe(off.handlers, { x: 200, y: 100 }, { x: 50, y: 100 });
    const blocked = mountGestures({ interactionBlocked: true });
    swipe(blocked.handlers, { x: 200, y: 100 }, { x: 50, y: 100 });
    expect(off.scrollByPage).not.toHaveBeenCalled();
    expect(blocked.scrollByPage).not.toHaveBeenCalled();
  });
});

describe("reader wheel contract", () => {
  it("leaves scroll mode wheel to native scrolling and locks tap paging briefly", () => {
    const { handlers, scrollByPage, nativeWheelActionLockedUntilRef } = mountGestures();
    const event = wheel(handlers, 120);
    expect(event.defaultPrevented).toBe(false);
    expect(scrollByPage).not.toHaveBeenCalled();
    expect(nativeWheelActionLockedUntilRef.current).toBeGreaterThan(0);
  });

  it("turns one page per cooldown in paged mode once the delta threshold is reached", () => {
    const { handlers, scrollByPage } = mountGestures({ isPagedReader: true });
    expect(wheel(handlers, 10).defaultPrevented).toBe(true);
    expect(scrollByPage).not.toHaveBeenCalled();
    wheel(handlers, 15);
    expect(scrollByPage).toHaveBeenCalledWith(1, "wheel-page-step");
    wheel(handlers, 120);
    expect(scrollByPage).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(220);
    wheel(handlers, -120);
    expect(scrollByPage).toHaveBeenLastCalledWith(-1, "wheel-page-step");
  });

  it("leaves Ctrl+wheel to browser zoom", () => {
    const { handlers, scrollByPage } = mountGestures({ isPagedReader: true });
    expect(wheel(handlers, 120, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(scrollByPage).not.toHaveBeenCalled();
  });
});
