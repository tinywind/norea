import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ChapterMediaElementPatch } from "../../lib/chapter-media";

const resolveLocalChapterMediaPatches = vi.hoisted(() => vi.fn());
vi.mock("../../lib/chapter-media", async (original) => ({
  ...(await original<typeof import("../../lib/chapter-media")>()),
  resolveLocalChapterMediaPatches,
}));

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
