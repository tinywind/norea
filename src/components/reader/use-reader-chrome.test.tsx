import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useReaderChrome } from "./use-reader-chrome";

type Chrome = ReturnType<typeof useReaderChrome>;
type ChromeOptions = Parameters<typeof useReaderChrome>[0];

let chrome: Chrome;
let root: Root;

function Probe(props: ChromeOptions) {
  chrome = useReaderChrome(props);
  return null;
}

const baseOptions: ChromeOptions = {
  chapterId: 11,
  fullPageReader: true,
  readerStateVisible: false,
};

const outside = {
  relatedTarget: null,
  currentTarget: { contains: () => false },
} as unknown as Parameters<Chrome["chromeFocusHandlers"]["onBlur"]>[0];

async function render(options: Partial<ChromeOptions> = {}) {
  await act(async () => root.render(<Probe {...baseOptions} {...options} />));
}

async function run(callback: () => void) {
  await act(async () => callback());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const document = {
    nodeType: 9, activeElement: null, body: null as unknown,
    documentElement: { nodeName: "HTML" }, addEventListener() {}, removeEventListener() {},
  };
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, firstChild: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  document.body = container;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    document,
    HTMLIFrameElement: class {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: number) => clearTimeout(id),
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Node", class {});
  root = createRoot(container as unknown as Element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reader chrome contract", () => {
  it("keeps the chrome visible in normal mode and a center tap does not hide it", async () => {
    await render({ fullPageReader: false });
    expect(chrome.readerChromeVisible).toBe(true);
    expect(chrome.readerChromeDismissible).toBe(false);
    await run(() => chrome.handleReaderMenuTap());
    expect(chrome.readerChromeVisible).toBe(true);
  });

  it("marks visible full-page chrome as dismissible by any tap", async () => {
    await render();
    expect(chrome.readerChromeDismissible).toBe(false);
    await run(() => chrome.handleReaderMenuTap());
    expect(chrome.readerChromeDismissible).toBe(true);
    await run(() => chrome.hideReaderChrome());
    expect(chrome.readerChromeVisible).toBe(false);
  });

  it("keeps the chrome and focus while focus stays inside it past the timeout", async () => {
    await render();
    await run(() => chrome.handleReaderMenuTap());
    await run(() => chrome.chromeFocusHandlers.onFocus());
    await run(() => vi.advanceTimersByTime(12_000));
    expect(chrome.readerChromeVisible).toBe(true);
    await run(() => chrome.chromeFocusHandlers.onBlur(outside));
    await run(() => vi.advanceTimersByTime(5000));
    expect(chrome.readerChromeVisible).toBe(false);
  });

  it("keeps the chrome during a seekbar drag and restarts the wait after it", async () => {
    await render();
    await run(() => chrome.handleReaderMenuTap());
    await run(() => chrome.handleReaderSeekbarActiveChange(true));
    await run(() => vi.advanceTimersByTime(12_000));
    expect(chrome.readerChromeVisible).toBe(true);
    await run(() => chrome.handleReaderSeekbarActiveChange(false));
    await run(() => vi.advanceTimersByTime(4000));
    expect(chrome.readerChromeVisible).toBe(true);
    await run(() => vi.advanceTimersByTime(1000));
    expect(chrome.readerChromeVisible).toBe(false);
  });

  it("closes the chapter list before settings as the topmost overlay", async () => {
    await render();
    await run(() => chrome.openReaderSettingsPanel());
    await run(() => chrome.openChapterList());
    let closed = false;
    await run(() => { closed = chrome.closeTopReaderOverlay(); });
    expect(closed).toBe(true);
    expect(chrome.chapterListOpen).toBe(false);
    expect(chrome.readerSettingsOpen).toBe(true);
    await run(() => { closed = chrome.closeTopReaderOverlay(); });
    expect(chrome.readerSettingsOpen).toBe(false);
    await run(() => { closed = chrome.closeTopReaderOverlay(); });
    expect(closed).toBe(false);
  });

  it("keeps the chrome while an overlay is open", async () => {
    await render();
    await run(() => chrome.openReaderSettingsPanel());
    await run(() => vi.advanceTimersByTime(12_000));
    expect(chrome.readerChromeVisible).toBe(true);
  });

  it("starts hidden in full-page mode and toggles with the center tap", async () => {
    await render();
    expect(chrome.readerChromeVisible).toBe(false);
    await run(() => chrome.handleReaderMenuTap());
    expect(chrome.readerChromeVisible).toBe(true);
    await run(() => chrome.handleReaderMenuTap());
    expect(chrome.readerChromeVisible).toBe(false);
  });

  it("hides full-page chrome after five idle seconds and activity restarts the wait", async () => {
    await render();
    await run(() => chrome.handleReaderMenuTap());
    await run(() => vi.advanceTimersByTime(4000));
    await run(() => chrome.handleReaderActivity());
    await run(() => vi.advanceTimersByTime(4000));
    expect(chrome.readerChromeVisible).toBe(true);
    await run(() => vi.advanceTimersByTime(1000));
    expect(chrome.readerChromeVisible).toBe(false);
  });

  it("hides full-page chrome again when the chapter changes", async () => {
    await render();
    await run(() => chrome.handleReaderMenuTap());
    await render({ chapterId: 12 });
    expect(chrome.readerChromeVisible).toBe(false);
  });

  it("shows full-page chrome while a loading or error state covers the content", async () => {
    await render({ readerStateVisible: true });
    expect(chrome.readerChromeVisible).toBe(true);
  });

  it("opens settings with the chrome shown and closes them on request", async () => {
    await render();
    await run(() => chrome.openReaderSettingsPanel());
    expect(chrome.readerSettingsOpen).toBe(true);
    expect(chrome.readerChromeVisible).toBe(true);
    await run(() => chrome.closeReaderSettingsPanel());
    expect(chrome.readerSettingsOpen).toBe(false);
  });
});
