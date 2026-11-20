import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ChapterMediaElementPatch } from "../../lib/chapter-media";
import {
  READER_PENDING_BACKGROUND_ATTRIBUTE,
  READER_PENDING_DISPLAY_ATTRIBUTE,
  READER_PENDING_HEIGHT_ATTRIBUTE,
  READER_PENDING_MEDIA_ATTRIBUTE,
  READER_PENDING_PLACEHOLDER_HEIGHT,
  READER_PENDING_PLACEHOLDER_SRC,
} from "../reader-document";

const resolveLocalChapterMediaPatches = vi.hoisted(() => vi.fn());
vi.mock("../../lib/chapter-media", async (original) => ({
  ...(await original<typeof import("../../lib/chapter-media")>()),
  resolveLocalChapterMediaPatches,
}));

import { protectLocalReaderMediaCached } from "./reader-content-media";
import { useReaderContentMedia } from "./use-reader-content-media";

let root: Root | undefined;

function createMockContainer(mediaSources: string[]) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const images = mediaSources.map((src) => ({
    getAttribute: (name: string) =>
      name === "data-norea-reader-local-media-src" ? encodeURIComponent(src) : null,
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
  }));
  return {
    querySelectorAll: () => images,
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchError: (target: unknown) => {
      for (const listener of listeners.get("error") ?? []) {
        listener({ target } as Event);
      }
    },
  };
}

function mountNullRenderer() {
  const doc = {
    nodeType: 9,
    activeElement: null,
    body: null as unknown,
    documentElement: { nodeName: "HTML" },
    createElement() {
      return {
        innerHTML: "",
        content: {
          querySelectorAll: () => [],
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: doc,
    firstChild: null,
    textContent: "",
    addEventListener() {},
    removeEventListener() {},
  };
  doc.body = container;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    document: doc,
    HTMLIFrameElement: class {},
    location: { href: "http://tauri.localhost/reader" },
    localStorage: { getItem: () => null },
  });
  vi.stubGlobal("HTMLElement", class MockHTMLElement {
    constructor(private readonly src: string) {}
    getAttribute(name: string) {
      return name === "src" ? this.src : null;
    }
  });
  vi.stubGlobal("HTMLImageElement", class MockHTMLImageElement {
    currentSrc: string;
    src: string;
    constructor(src: string) {
      this.currentSrc = src;
      this.src = src;
    }
    getAttribute(name: string) {
      return name === "src" ? this.src : null;
    }
  });
  vi.stubGlobal("HTMLVideoElement", class {});
  vi.stubGlobal("HTMLAudioElement", class {});
  vi.stubGlobal("HTMLSourceElement", class {});
  vi.stubGlobal("HTMLEmbedElement", class {});
  vi.stubGlobal("HTMLIFrameElement", class {});
  vi.stubGlobal("HTMLObjectElement", class {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return createRoot(container as unknown as Element);
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reports missing local media to onMediaError when archive cache preparation yields no patches", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  root = mountNullRenderer();
  resolveLocalChapterMediaPatches.mockResolvedValue([] as ChapterMediaElementPatch[]);
  const onMediaError = vi.fn();
  const mockContent = createMockContainer(["norea-media://reader-asset/0001-001.jpg"]);
  const contentRef = { current: mockContent as unknown as HTMLDivElement };

  function Probe() {
    useReaderContentMedia({
      contentKey: "61192:stored",
      renderedHtml: '<img src="norea-media://reader-asset/0001-001.jpg" />',
      localMediaContext: { chapterId: 61192, novelId: 127, sourceId: "goodtoon-webtoon", sourceNovelId: "gt-60909" },
      contentRef,
      activeVirtualRangeStart: 0,
      activeVirtualRangeEnd: 0,
      isPagedReader: false,
      onMediaError,
    });
    return null;
  }

  await act(async () => {
    root!.render(<Probe />);
  });

  expect(resolveLocalChapterMediaPatches).toHaveBeenCalledOnce();
  expect(onMediaError).toHaveBeenCalledExactlyOnceWith("norea-media://reader-asset/0001-001.jpg");
});

it("reports local cached norea-media image load errors to onMediaError", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  root = mountNullRenderer();
  resolveLocalChapterMediaPatches.mockResolvedValue([]);
  const onMediaError = vi.fn();
  const mockContent = createMockContainer([]);
  const contentRef = { current: mockContent as unknown as HTMLDivElement };

  function Probe() {
    useReaderContentMedia({
      contentKey: "61192:stored",
      renderedHtml: "<p>Chapter</p>",
      localMediaContext: { chapterId: 61192, novelId: 127, sourceId: "goodtoon-webtoon", sourceNovelId: "gt-60909" },
      contentRef,
      activeVirtualRangeStart: 0,
      activeVirtualRangeEnd: 0,
      isPagedReader: false,
      onMediaError,
    });
    return null;
  }

  await act(async () => {
    root!.render(<Probe />);
  });

  const failedImage = new (globalThis.HTMLImageElement as unknown as new (src: string) => HTMLImageElement)(
    "http://norea-media.localhost/reader-asset/~cache/tok/0060-060.jpg",
  );
  mockContent.dispatchError(failedImage);
  expect(onMediaError).toHaveBeenCalledExactlyOnceWith(
    "http://norea-media.localhost/reader-asset/~cache/tok/0060-060.jpg",
  );
});

it("patches local images in-place without re-rendering and keeps placeholder height until the real image loads or fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  root = mountNullRenderer();
  const MockImage = globalThis.HTMLImageElement as unknown as new (src: string) => {
    currentSrc: string;
    src: string;
    getAttribute(name: string): string | null;
  };
  class PendingMockImage extends MockImage {
    readonly attrMap = new Map<string, string>();
    complete = false;
    naturalWidth = 0;
    readonly style: {
      display: string;
      minHeight: string;
      backgroundColor: string;
      removeProperty: (property: string) => void;
    };
    constructor(protectedSrc: string) {
      super(READER_PENDING_PLACEHOLDER_SRC);
      this.attrMap.set("src", READER_PENDING_PLACEHOLDER_SRC);
      this.attrMap.set("data-norea-reader-local-media-src", encodeURIComponent(protectedSrc));
      this.attrMap.set(READER_PENDING_MEDIA_ATTRIBUTE, "true");
      this.attrMap.set(READER_PENDING_DISPLAY_ATTRIBUTE, "true");
      this.attrMap.set(READER_PENDING_HEIGHT_ATTRIBUTE, "true");
      this.attrMap.set(READER_PENDING_BACKGROUND_ATTRIBUTE, "true");
      this.style = {
        display: "block",
        minHeight: READER_PENDING_PLACEHOLDER_HEIGHT,
        backgroundColor: "rgba(148, 163, 184, 0.12)",
        removeProperty: (property: string) => {
          if (property === "display") this.style.display = "";
          if (property === "min-height") this.style.minHeight = "";
          if (property === "background-color") this.style.backgroundColor = "";
        },
      };
    }
    override getAttribute(name: string) {
      return this.attrMap.get(name) ?? null;
    }
    hasAttribute(name: string) {
      return this.attrMap.has(name);
    }
    setAttribute(name: string, value: string) {
      this.attrMap.set(name, value);
      if (name === "src") this.src = value;
    }
    removeAttribute(name: string) {
      this.attrMap.delete(name);
    }
  }

  const firstImage = new PendingMockImage("norea-media://reader-asset/0001-001.jpg");
  const secondImage = new PendingMockImage("norea-media://reader-asset/0002-002.jpg");
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const mockContent = {
    querySelectorAll: () => [firstImage, secondImage],
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatch: (type: "load" | "error", target: unknown) => {
      for (const listener of listeners.get(type) ?? []) {
        listener({ target, type } as Event);
      }
    },
  };
  resolveLocalChapterMediaPatches.mockResolvedValue([
    {
      index: 0,
      attributes: { src: "http://norea-media.localhost/reader-asset/~cache/tok/0001-001.jpg" },
      sourceAttributes: { src: "norea-media://reader-asset/0001-001.jpg" },
    },
    {
      index: 1,
      attributes: { src: "http://norea-media.localhost/reader-asset/~cache/tok/0002-002.jpg" },
      sourceAttributes: { src: "norea-media://reader-asset/0002-002.jpg" },
    },
  ] satisfies ChapterMediaElementPatch[]);
  const contentRef = { current: mockContent as unknown as HTMLDivElement };
  let renderCount = 0;

  function Probe() {
    renderCount += 1;
    useReaderContentMedia({
      contentKey: "61192:stored",
      renderedHtml:
        '<img src="norea-media://reader-asset/0001-001.jpg" /><img src="norea-media://reader-asset/0002-002.jpg" />',
      localMediaContext: { chapterId: 61192, novelId: 127, sourceId: "webtoon", sourceNovelId: "w-1" },
      contentRef,
      activeVirtualRangeStart: 0,
      activeVirtualRangeEnd: 0,
      isPagedReader: false,
      // Omit onMediaError to mirror preparing === true.
    });
    return null;
  }

  await act(async () => {
    root!.render(<Probe />);
  });

  expect(renderCount).toBe(1);
  expect(firstImage.getAttribute("src")).toBe(
    "http://norea-media.localhost/reader-asset/~cache/tok/0001-001.jpg",
  );
  // Placeholder styles stay intact right after patching before the real image decodes.
  expect(firstImage.hasAttribute(READER_PENDING_MEDIA_ATTRIBUTE)).toBe(true);
  expect(firstImage.style.minHeight).toBe(READER_PENDING_PLACEHOLDER_HEIGHT);

  // Stale placeholder load event (currentSrc still placeholder or complete === false) must not clear styles.
  firstImage.currentSrc = READER_PENDING_PLACEHOLDER_SRC;
  firstImage.complete = true;
  mockContent.dispatch("load", firstImage);
  expect(firstImage.hasAttribute(READER_PENDING_MEDIA_ATTRIBUTE)).toBe(true);
  expect(firstImage.style.minHeight).toBe(READER_PENDING_PLACEHOLDER_HEIGHT);

  firstImage.currentSrc = "http://norea-media.localhost/reader-asset/~cache/tok/0001-001.jpg";
  firstImage.complete = false;
  mockContent.dispatch("load", firstImage);
  expect(firstImage.hasAttribute(READER_PENDING_MEDIA_ATTRIBUTE)).toBe(true);

  // Real image load clears pending styles even without onMediaError (preparing mode).
  firstImage.complete = true;
  firstImage.naturalWidth = 800;
  mockContent.dispatch("load", firstImage);
  expect(firstImage.hasAttribute(READER_PENDING_MEDIA_ATTRIBUTE)).toBe(false);
  expect(firstImage.style.minHeight).toBe("");
  expect(firstImage.style.display).toBe("");
  expect(firstImage.style.backgroundColor).toBe("");

  // Real image error also clears pending styles so restore settle and boundary checks do not stall.
  secondImage.currentSrc = "http://norea-media.localhost/reader-asset/~cache/tok/0002-002.jpg";
  mockContent.dispatch("error", secondImage);
  expect(secondImage.hasAttribute(READER_PENDING_MEDIA_ATTRIBUTE)).toBe(false);
  expect(secondImage.style.minHeight).toBe("");
});

it("keeps pending image styles when protectLocalReaderMediaCached renders pre-resolved local URLs", () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  class TemplateMockImage {
    readonly attributes = new Map<string, string>([
      ["src", "norea-media%3A%2F%2Freader-asset%2F0001-001.jpg"],
    ]);
    readonly style = { display: "", minHeight: "", backgroundColor: "" };
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
  }
  const image = new TemplateMockImage();
  vi.stubGlobal("HTMLImageElement", TemplateMockImage);
  vi.stubGlobal("document", {
    createElement: () => ({
      innerHTML: "",
      content: { querySelectorAll: () => [image] },
    }),
  });

  protectLocalReaderMediaCached(
    '<img src="norea-media%3A%2F%2Freader-asset%2F0001-001.jpg" />',
    new Map([
      [
        "norea-media://reader-asset/0001-001.jpg",
        "http://norea-media.localhost/reader-asset/~cache/tok/0001-001.jpg",
      ],
    ]),
    true,
  );

  expect(image.getAttribute("src")).toBe(
    "http://norea-media.localhost/reader-asset/~cache/tok/0001-001.jpg",
  );
  expect(image.getAttribute(READER_PENDING_MEDIA_ATTRIBUTE)).toBe("true");
  expect(image.style.minHeight).toBe(READER_PENDING_PLACEHOLDER_HEIGHT);
});

it("matches partially resolved local patches by index and restores them after innerHTML replacement", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  root = mountNullRenderer();
  const makeImage = (protectedSrc: string) => {
    const attrs = new Map<string, string>([
      ["src", READER_PENDING_PLACEHOLDER_SRC],
      ["data-norea-reader-local-media-src", encodeURIComponent(protectedSrc)],
      [READER_PENDING_MEDIA_ATTRIBUTE, "true"],
    ]);
    return {
      getAttribute: (name: string) => attrs.get(name) ?? null,
      hasAttribute: (name: string) => attrs.has(name),
      setAttribute: (name: string, value: string) => { attrs.set(name, value); },
      removeAttribute: (name: string) => { attrs.delete(name); },
      style: { removeProperty: vi.fn() },
    };
  };
  let mountedImages = [
    makeImage("norea-media://reader-asset/missing.jpg"),
    makeImage("norea-media://reader-asset/present.jpg"),
  ];
  const mockContent = {
    querySelectorAll: () => mountedImages,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  resolveLocalChapterMediaPatches.mockResolvedValue([
    {
      index: 1,
      attributes: { src: "http://norea-media.localhost/reader-asset/~cache/tok/present.jpg" },
      sourceAttributes: { src: "norea-media://reader-asset/present.jpg" },
    },
  ] satisfies ChapterMediaElementPatch[]);
  const onMediaError = vi.fn();
  const contentRef = { current: mockContent as unknown as HTMLDivElement };
  let restoreMediaPatches!: (html: string) => void;

  function Probe() {
    ({ restoreMediaPatches } = useReaderContentMedia({
      contentKey: "61192:stored",
      renderedHtml:
        '<img src="norea-media://reader-asset/missing.jpg" /><img src="norea-media://reader-asset/present.jpg" />',
      localMediaContext: { chapterId: 61192, novelId: 127, sourceId: "webtoon", sourceNovelId: "w-1" },
      contentRef,
      activeVirtualRangeStart: 0,
      activeVirtualRangeEnd: 0,
      isPagedReader: false,
      onMediaError,
    }));
    return null;
  }

  await act(async () => {
    root!.render(<Probe />);
  });

  expect(onMediaError).toHaveBeenCalledExactlyOnceWith("norea-media://reader-asset/missing.jpg");
  expect(mountedImages[0]!.getAttribute("src")).toBe(READER_PENDING_PLACEHOLDER_SRC);
  expect(mountedImages[1]!.getAttribute("src")).toBe(
    "http://norea-media.localhost/reader-asset/~cache/tok/present.jpg",
  );

  // Simulate DOM replacement (e.g. toggling bionicReading): restoreMediaPatches re-applies only the resolved image.
  mountedImages = [
    makeImage("norea-media://reader-asset/missing.jpg"),
    makeImage("norea-media://reader-asset/present.jpg"),
  ];
  restoreMediaPatches("<replaced>");
  expect(mountedImages[0]!.getAttribute("src")).toBe(READER_PENDING_PLACEHOLDER_SRC);
  expect(mountedImages[1]!.getAttribute("src")).toBe(
    "http://norea-media.localhost/reader-asset/~cache/tok/present.jpg",
  );
});

it("buffers unresolved and broken local media errors while preparing and replays them upon promotion", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  root = mountNullRenderer();
  resolveLocalChapterMediaPatches.mockResolvedValue([] as ChapterMediaElementPatch[]);
  const mockContent = createMockContainer(["norea-media://reader-asset/missing.jpg"]);
  const contentRef = { current: mockContent as unknown as HTMLDivElement };
  const onMediaError = vi.fn();

  function Probe({
    active,
    contentKey = "61192:stored",
  }: {
    active: boolean;
    contentKey?: string;
  }) {
    useReaderContentMedia({
      contentKey,
      renderedHtml: '<img src="norea-media://reader-asset/missing.jpg" />',
      localMediaContext: { chapterId: 61192, novelId: 127, sourceId: "webtoon", sourceNovelId: "w-1" },
      contentRef,
      activeVirtualRangeStart: 0,
      activeVirtualRangeEnd: 0,
      isPagedReader: false,
      onMediaError: active ? onMediaError : undefined,
    });
    return null;
  }

  // While preparing (onMediaError undefined), error is buffered instead of dropped.
  await act(async () => {
    root!.render(<Probe active={false} />);
  });
  expect(onMediaError).not.toHaveBeenCalled();

  // Promotion replays the buffered unresolved-media error.
  await act(async () => {
    root!.render(<Probe active={true} />);
  });
  expect(onMediaError).toHaveBeenCalledExactlyOnceWith("norea-media://reader-asset/missing.jpg");

  // Also verify DOM image load errors while preparing replay on promotion, and clear on contentKey change.
  onMediaError.mockClear();
  await act(async () => {
    root!.render(<Probe active={false} contentKey="61193:stored" />);
  });
  const failedImage = new (globalThis.HTMLImageElement as unknown as new (src: string) => HTMLImageElement)(
    "http://norea-media.localhost/reader-asset/~cache/tok/corrupt.jpg",
  );
  mockContent.dispatchError(failedImage);
  expect(onMediaError).not.toHaveBeenCalled();

  await act(async () => {
    root!.render(<Probe active={true} contentKey="61193:stored" />);
  });
  expect(onMediaError).toHaveBeenCalledExactlyOnceWith(
    "http://norea-media.localhost/reader-asset/~cache/tok/corrupt.jpg",
  );
});

it("restores all known local media from the resolved map during restoreMediaPatches even when another image is unresolved", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  root = mountNullRenderer();
  const makeImage = (protectedSrc: string) => {
    const attrs = new Map<string, string>([
      ["src", READER_PENDING_PLACEHOLDER_SRC],
      ["data-norea-reader-local-media-src", encodeURIComponent(protectedSrc)],
      [READER_PENDING_MEDIA_ATTRIBUTE, "true"],
    ]);
    return {
      getAttribute: (name: string) => attrs.get(name) ?? null,
      hasAttribute: (name: string) => attrs.has(name),
      setAttribute: (name: string, value: string) => { attrs.set(name, value); },
      removeAttribute: (name: string) => { attrs.delete(name); },
      style: { removeProperty: vi.fn() },
    };
  };
  let mountedImages = [
    makeImage("norea-media://reader-asset/a.jpg"),
    makeImage("norea-media://reader-asset/missing.jpg"),
    makeImage("norea-media://reader-asset/c.jpg"),
  ];
  const mockContent = {
    querySelectorAll: () => mountedImages,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  // Pass 1 resolves a.jpg (index 0) and c.jpg (index 2); missing.jpg (index 1) fails.
  resolveLocalChapterMediaPatches
    .mockResolvedValueOnce([
      {
        index: 0,
        attributes: { src: "http://norea-media.localhost/reader-asset/~cache/tok/a.jpg" },
        sourceAttributes: { src: "norea-media://reader-asset/a.jpg" },
      },
      {
        index: 2,
        attributes: { src: "http://norea-media.localhost/reader-asset/~cache/tok/c.jpg" },
        sourceAttributes: { src: "norea-media://reader-asset/c.jpg" },
      },
    ] satisfies ChapterMediaElementPatch[])
    // Pass 2 (after renderedHtml changes and missing.jpg is retried) resolves missing.jpg alone.
    .mockResolvedValueOnce([
      {
        index: 1,
        attributes: { src: "http://norea-media.localhost/reader-asset/~cache/tok/missing.jpg" },
        sourceAttributes: { src: "norea-media://reader-asset/missing.jpg" },
      },
    ] satisfies ChapterMediaElementPatch[]);

  const contentRef = { current: mockContent as unknown as HTMLDivElement };
  let restoreMediaPatches!: (html: string) => void;

  function Probe({ renderedHtml }: { renderedHtml: string }) {
    ({ restoreMediaPatches } = useReaderContentMedia({
      contentKey: "61194:stored",
      renderedHtml,
      localMediaContext: { chapterId: 61194, novelId: 127, sourceId: "webtoon", sourceNovelId: "w-1" },
      contentRef,
      activeVirtualRangeStart: 0,
      activeVirtualRangeEnd: 0,
      isPagedReader: false,
    }));
    return null;
  }

  await act(async () => {
    root!.render(<Probe renderedHtml="v1" />);
  });
  expect(mountedImages[0]!.getAttribute("src")).toBe("http://norea-media.localhost/reader-asset/~cache/tok/a.jpg");
  expect(mountedImages[1]!.getAttribute("src")).toBe(READER_PENDING_PLACEHOLDER_SRC);
  expect(mountedImages[2]!.getAttribute("src")).toBe("http://norea-media.localhost/reader-asset/~cache/tok/c.jpg");

  // Trigger pass 2 where only missing.jpg is still unresolved on the DOM and resolves on retry.
  await act(async () => {
    root!.render(<Probe renderedHtml="v2" />);
  });
  expect(mountedImages[1]!.getAttribute("src")).toBe("http://norea-media.localhost/reader-asset/~cache/tok/missing.jpg");

  // Subsequent DOM replacement must restore all three images (pass 2 must not have wiped a.jpg / c.jpg).
  mountedImages = [
    makeImage("norea-media://reader-asset/a.jpg"),
    makeImage("norea-media://reader-asset/missing.jpg"),
    makeImage("norea-media://reader-asset/c.jpg"),
  ];
  restoreMediaPatches("<replaced-again>");
  expect(mountedImages[0]!.getAttribute("src")).toBe("http://norea-media.localhost/reader-asset/~cache/tok/a.jpg");
  expect(mountedImages[1]!.getAttribute("src")).toBe("http://norea-media.localhost/reader-asset/~cache/tok/missing.jpg");
  expect(mountedImages[2]!.getAttribute("src")).toBe("http://norea-media.localhost/reader-asset/~cache/tok/c.jpg");
});
